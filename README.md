# Bison Sales Dashboards

Standalone project that turns Odoo data into self-contained HTML dashboards for
the office TV screens — kiosk display, not a chat tool. Phase 1 reproduces the
Dashboard Ninja "Sales Graph" (cumulative daily Target / Breakeven / Orders /
Invoiced for the current month) using only Odoo's ORM (`search_read` /
`read_group`), no raw SQL, then generalises into a small YAML-config system so
new dashboards mostly don't need new code.

This is separate from the `../outputs/server.py` MCP server, though it reuses
the same `OdooClient` connection pattern (env-var creds, XML-RPC, the same TLS
relaxation for this network's inspection appliance).

## Architecture

There are two moving parts: a static HTML shell, and one Pages Function per
dashboard that queries Odoo when asked.

```
Cloudflare Pages Function  functions/<dashboard>/data.json.js
  → serves GET /<dashboard>/data.json
  → queries Odoo at request time (hand-rolled XML-RPC over fetch, lib/)
  → computes cumulative sums, weekend folding, CRM weighting, returns JSON
  → Odoo credentials are Pages secrets; nothing else can reach them
  → same domain as the HTML, so Cloudflare Access gates it with the same
    policy — verified by requesting it unauthenticated and confirming a
    302 to the Access login rather than a 200 with data

Static shell  (generate.py --shell → Cloudflare Pages)
  → Jinja renders title/theme/panel grid from config/*.yaml only
  → contains NO Odoo data and needs NO Odoo credentials to build
  → deployed by GitHub Actions on push, not on a schedule

TV browser
  → opens the Pages URL once, authenticates through Cloudflare Access
  → fetches data.json immediately, then every `refresh_seconds` (120s)
  → redraws Chart.js in place; no page reload, no flash
```

### How it got here, and what was wrong with the previous designs

**GitHub Actions on a cron** (first attempt) failed twice over: its
`schedule:` trigger is unreliable at short intervals (multi-hour gaps observed
against a nominal `*/10` cron), and Actions minutes are billed per run, so a
2-minute cadence would have cost roughly **$150+/month** on a private repo.

**A cron Worker writing to KV** (second attempt) fixed the reliability and the
cost, but broke in two ways of its own:

1. *KV write quota.* Two keys × 720 cron firings/day = 1,440 writes against a
   free-tier cap of 1,000/day. Writes silently began failing partway through
   each day. Fixed at the time by combining both dashboards into one write.
2. *CPU limit.* The free tier allows **10ms CPU per invocation**, and the job
   exceeded it (`outcome: "exceededCpu"`), so KV stopped being written
   entirely and the screens went hours stale. The main cost was pulling ~734
   `crm.lead` rows and parsing them all to produce five numbers — now done
   with `read_group` so Postgres aggregates and five rows come back.

The current design removes the Worker, the KV namespace, the cron trigger and
the write quota altogether: the Function does the query when the page asks. A
single screen polling every 2 minutes is ~720 Odoo queries/day, the same
volume the cron was doing, so nothing is worse off for load.

### Two things to know about the current design

**The 10ms CPU ceiling still applies.** Pages Functions run on the same
runtime as Workers, so the free tier's 10ms CPU/invocation limit is still
overhead. The `read_group` change bought real headroom, but this is a ceiling,
not a solved problem: as CRM and order volume grow it can be breached again.
The symptom is a `502` from `/data.json` and the stale banner appearing on the
screens. **The fix if that happens is the Workers Standard plan at $5/month**,
which raises the limit to 30s and makes the issue permanently moot. Worth
glancing at Cloudflare's Workers analytics (Errors, CPU time P90) occasionally.

**The aggregation logic exists in two languages.** `dashboards/*.py`
(Python/pandas) and `lib/*.js` are independent implementations of the same
rules, because Cloudflare's Python runtime can't give `xmlrpc.client` a working
socket transport. `lib/` is what production uses; the Python path is kept for
local preview and — more usefully — as the reference the JS is diff-tested
against (`npm run livetest` compares every series, panel, KPI and table row on
live data). They are *not* mechanically kept in sync: change a business rule
and you must change it in both, then run the parity check. `lib/configs.js`
likewise duplicates `config/*.yaml`. This is the real remaining cost of the
design and it is not an oversight.

## Project layout

```
sales-dashboards/
  dashboards/
    odoo_client.py       OdooClient (XML-RPC), + read_group
    data_sources.py      generic read_group-by-day helper
    special_sources.py   the one composite source Orders needs (see below)
    config_schema.py     YAML -> DashboardConfig/SeriesConfig
    build.py             config -> data.json payload (cumulative sums, pandas)
    render.py            payload -> index.html + data.json (Jinja2)
  templates/
    dashboard.html.j2     Chart.js + CSS-variable theme + fetch/redraw JS
  config/
    sales_graph.yaml      the first dashboard
    shell_build.py       config -> data-less payload for the deployed HTML
  scripts/
    generate.py           CLI entrypoint (--shell for the no-Odoo render)
  functions/              Cloudflare Pages Functions. THE only thing that
                          talks to Odoo in production. Same domain as the
                          HTML, so they inherit the Access gate.
    <dashboard>/data.json.js
  lib/                    the JS data layer the Functions import (a parallel
                          implementation of dashboards/*.py — see Architecture)
    xmlrpc.js              hand-rolled XML-RPC codec (no DOMParser in Workers)
    index.js               buildDashboardPayload(env, name)
    *.test.mjs             unit tests — `npm test`, no network or creds needed
    *.livetest.mjs         live-Odoo tests + the JS-vs-Python parity check —
                          `npm run livetest`
  .github/workflows/
    refresh.yml            push/manual-triggered shell build + Pages deploy
  output/                 generated HTML/JSON (gitignored, deploy artifact only)
```

## Local setup

```bash
cd sales-dashboards
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows
# .venv/bin/pip install -r requirements.txt        # macOS/Linux

cp .env.example .env
# edit .env: ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_PASSWORD
```

Two ways to run it locally, for different jobs.

**Preview the HTML with real data baked in** (no Cloudflare involved):

```bash
.venv/Scripts/python scripts/generate.py --all
```

Then serve `output/` over HTTP (`python -m http.server`) — not `file://`,
because the page fetches `./data.json` on a relative path.

**Exercise the real production path** — the Pages Function querying Odoo live,
which is what actually runs in production:

```bash
cp .env .dev.vars                       # gitignored; how wrangler passes secrets
.venv/Scripts/python scripts/generate.py --all --shell
cp -r functions output/
npx wrangler pages dev output --port 8811
curl -s http://127.0.0.1:8811/sales_graph/data.json | head -c 400
```

This is the check that matters before deploying, because it runs the Function
code, the `lib/` data layer and the shell HTML together. Note that Cloudflare
Access does not apply locally, so the local endpoint is unauthenticated —
that's expected, and it's why production must be verified separately (see
"Keeping it running").

Tests:

```bash
npm test        # unit tests: XML-RPC codec + date/weekend logic. No creds.
npm run livetest # hits live Odoo, then diffs JS output against Python output
```

## Adding a new dashboard

Most dashboards are just "one model, one date field, one measure, summed per
day" — that's a plain YAML file, no code:

```yaml
name: my_dashboard
title: "My Dashboard"
chart_type: line
unit: currency          # or "number"
currency_symbol: "£"
refresh_seconds: 300
theme:
  background: "#ffffff"
  font_color: "#111111"
  header_bg: "#2b6cb0"
  header_font_color: "#ffffff"
series:
  - key: some_series
    label: "Some Series"
    color: "#2b6cb0"
    source: read_group
    model: sale.order
    domain: [["state", "=", "sale"]]
    date_field: date_order
    measure: amount_untaxed
    cumulative: true
    extend_to_month_end: false   # true = draw the whole month (pace/reference lines)
```

Drop it in `config/`, run `generate.py --all`. That's the whole "config, not
code" path from requirement 4.

**A new YAML config alone will not go live.** The YAML drives the HTML shell
(title, theme, panel grid). The *data* comes from the Pages Function, which
reads `lib/configs.js` — so a new dashboard also needs:

1. its config added to `lib/configs.js`,
2. any new composite source added to `lib/specialSources.js` / `lib/crmSources.js`,
3. a Pages Function at `functions/<name>/data.json.js` (copy an existing one and
   change the dashboard name),
4. the name accepted in `buildDashboardPayload()` in `lib/index.js`.

Then `npm run livetest` to confirm the JS and Python agree. This four-step
duplication is the cost noted in Architecture; it's the price of the data layer
running on Cloudflare's JS runtime rather than in Python.

**When it doesn't fit that shape** — e.g. the Sales Graph's "Orders" line,
which is really three sums combined (confirmed orders + proformas +
a monthly subscription-invoicing lump, all by different domains/models) before
the running total is taken — write a small Python function in
`dashboards/special_sources.py`, register it in `COMPOSITE_SOURCES`, and
reference it from the config as `source: my_function_name` instead of
`source: read_group`. `sales_orders_component` is the existing example to
copy.

## Multi-panel dashboards

Some Dashboard Ninja exports are a whole screen, not one chart — e.g.
`config/sales_dashboard.yaml` (two line charts, a KPI tile, and a pipeline
table, in a 2-column grid). This is a **separate config shape**, detected
automatically by the presence of a top-level `panels:` key — `generate.py`
picks the right builder/template on its own, no flag needed.

Each panel has a `type` (`line_chart` | `kpi` | `table`), a `col`
(`left`/`right`) and `flex` (relative height weight within that column —
e.g. a short KPI tile at `flex: 3` above a taller table at `flex: 6`), plus
its own `theme:` (panels can have wildly different colours, like the blue KPI
tile against otherwise-white panels).

- `line_chart` panels reuse the same `series:` shape as a single-chart
  dashboard, plus `granularity: day` or `month` (month-granularity panels use
  a full calendar year as their x-axis instead of the current month, and
  `extend: true` means "draw to December" rather than "draw to month-end").
  Composite sources need a monthly-bucketed twin if a daily one already
  exists for another panel — `orders_ytd_monthly_component` in
  `special_sources.py` is the Year-To-Date analogue of
  `sales_orders_component`, since the two charts bucket the same underlying
  data differently (daily-this-month vs monthly-this-year).
- `kpi` and `table` panels have no generic "config, not code" path — they're
  backed by a named Python function (`source: crm_new_opportunities_week`,
  `source: crm_pipeline_table`, both in `dashboards/crm_sources.py`) since a
  scalar count or a grouped-and-weighted table doesn't reduce to "one model,
  one measure, groupby date" the way a chart series does. `columns:` on a
  table panel just describes how to *format* whatever rows the source
  function returns (`text` | `number` | `currency`).

The zoom control on this template is intentionally independent from the
single-chart dashboard's (separate `localStorage` key) — they're different
pages, plausibly on different physical screens, and shouldn't fight over one
saved scale preference.

## Keeping it running

There is one deploy: the Pages project. It carries both the HTML shell and the
Functions.

```bash
npm test                                            # always, before deploying
npm run livetest                                    # if you touched lib/ or dashboards/
.venv/Scripts/python scripts/generate.py --all --shell
cp -r functions output/
npm run deploy                                      # wrangler pages deploy output
```

Pushing to `main` does the same thing via GitHub Actions, so normally you just
push. Deploy by hand only when you want to skip CI.

**Where the secrets live:**

- **Odoo credentials** — Cloudflare **Pages** secrets only (`wrangler pages
  secret put <NAME> --project-name bison-dashboards`). Four of them:
  `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_PASSWORD`. Nothing else in the
  system can reach Odoo; GitHub no longer holds these at all.
- **GitHub Actions** — only `CLOUDFLARE_API_TOKEN` (scoped to *Pages: Edit*)
  and `CLOUDFLARE_ACCOUNT_ID` (`5d255a554c200f7a0de4cd895d4d4073`). CI renders
  with `--shell`, so it has no reason to talk to Odoo.
- **Locally** — `.env` for the Python path, `.dev.vars` for `wrangler pages
  dev`. Both gitignored.

**Live now:**
- **https://bison-dashboards.pages.dev/sales_graph/**
- **https://bison-dashboards.pages.dev/sales_dashboard/**

Both are gated by Cloudflare Access, including the `/data.json` endpoints —
confirmed by requesting them unauthenticated and getting a 302 to the Access
login rather than a 200 with data. Re-check that after any change that adds a
route. Whoever administers Access should confirm the policy is scoped to the
right people; that policy was not configured from here.

### If the screens go stale

In order of likelihood:

1. **`/data.json` returning 502.** Open it in an authenticated browser tab. The
   body carries the error message. If it mentions CPU, see the 10ms ceiling
   note in Architecture — the answer is the $5/month Workers Standard plan.
2. **Check Cloudflare → Workers & Pages → your project → Functions metrics**
   for error rate and CPU time P90. A rising P90 near 10ms is the early
   warning that used to be invisible.
3. **Odoo unreachable or credentials rotated.** `npm run livetest` locally will
   fail the same way and tell you which.
4. The page shows a red stale banner after 4× the refresh interval without a
   successful fetch, so a dead feed announces itself rather than quietly
   showing old numbers.

## Pointing a screen at it

Any smart-TV/kiosk browser: open the Pages URL and leave the tab open.
- Disable the TV's screensaver/sleep timer for that input/app.
- The page redraws its data every `refresh_seconds` (2 min for the two live dashboards)
  without reloading, and does one full reload every 6 hours as a safety net
  against stuck JS state — you won't need to touch it day-to-day.
- If the data feed goes stale (no successful refresh for 4× the refresh
  interval) a red banner appears so you know it's showing old numbers rather
  than silently going wrong.

## Phase 2 (not built): Dashboard Ninja JSON → config, via MCP

Feasible, with a caveat. A tool like `translate_dashboard_ninja_export(json)`
could have Claude read the export's `ks_custom_query`, `ks_ylabels`, colours
etc. and draft a `config/*.yaml` automatically — that part's straightforward
for exports shaped like this one (per-model sums grouped by date).

What it can't do reliably is fully automatic translation of *arbitrary* SQL:
Dashboard Ninja lets you write anything Postgres can express (arbitrary
joins, window functions, subqueries), and Odoo's ORM domains/read_group can't
represent all of that. The realistic version of this tool is an **assisted
draft generator** — it produces a best-effort config plus a plain-English
list of anything in the query it couldn't map (e.g. "this join has no ORM
equivalent, write a composite source for it manually"), the way this project
itself needed one hand-written `special_sources.py` function for the
Sales Graph's subscription-invoicing lump sum. Worth building once you have
2-3 more dashboards to migrate and can see the actual pattern of what maps
cleanly vs. what needs a human.

## Notes on the Odoo v18 field mapping (Sales Graph)

The original SQL referenced tables/fields that don't exist 1:1 in this Odoo
version; the config maps them as:

| SQL export | This Odoo instance (checked live) |
|---|---|
| `x_daily_sales_targets` (`x_studio_date`, `x_studio_company_daily_target`, `x_studio_company_daily_breakeven`) | same model/fields, still present |
| `bison_core_account_move_gp_report` | registered as model `bison_core.account_move_gp_report` (fields: `sales_target_date`, `aml_total_net`, `move_id`, `move_type`) |
| `sale_subscription` (table of contract `code`s) | subscriptions are now `sale.order` records with `is_subscription = True`; matched to invoices via `account.move.invoice_origin` same as before |
| `machinary_stage_id = 2` (Proforma) | confirmed live: stage id 2 = "PROFORMA" |
