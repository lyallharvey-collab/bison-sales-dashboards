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

Live data refresh (every ~2 minutes) now runs entirely on Cloudflare, not
GitHub Actions:

```
bison-dashboard-refresher (Cloudflare Worker, Cron Trigger every 2 min)
  → pulls Odoo directly via a hand-rolled XML-RPC-over-fetch client
  → computes the same cumulative sums / weekend-folding / CRM weighting
    as the Python pipeline (worker/src/*.js — a JS port, verified value-
    for-value against the Python output before it ever shipped)
  → writes JSON to a Cloudflare KV namespace (DASHBOARD_DATA)

Cloudflare Pages Functions (functions/<dashboard>/data.json.js)
  → intercept GET /<dashboard>/data.json, read the live payload from KV
  → same domain/zone as the rest of the site, so Cloudflare Access gates
    these exactly like the HTML pages — verified by curling them directly
    and confirming the 302-to-Access-login, not assumed

TV browser
  → opens the Pages URL once, authenticates through Cloudflare Access
  → page JS fetches data.json immediately on load, then every
    `refresh_seconds` (120s) — redraws Chart.js in place, no reload
```

**Why not GitHub Actions on a tight schedule?** The original design ran the
Odoo pull as a GitHub Actions cron job. Two problems surfaced in practice:
GitHub's `schedule:` trigger is genuinely unreliable at short intervals (gaps
of hours were observed against a nominal `*/10` cron, not just the
documented "occasionally a few minutes late"), and — more fundamentally —
GitHub bills Actions minutes per run; a 2-minute cadence would cost roughly
**$150+/month** on a private repo, since the billing meter cares about how
often the actual job runs, not what triggers it. A Cloudflare Worker's Cron
Trigger is both more reliable at short intervals and free at this volume, so
the live-refresh path moved there entirely.

**The tradeoff this introduces:** the aggregation logic now genuinely exists
in two languages — `dashboards/*.py` (Python/pandas) and `worker/src/*.js`
(hand-ported to JavaScript, since Cloudflare's Python Workers runtime can't
give `xmlrpc.client` a working transport for real outbound sockets). Before
shipping the JS port, every series/panel was diff-tested against the
Python-computed output on live data (`worker/src/compare.livetest.mjs`) —
they matched exactly. But the two are not mechanically kept in sync: if you
change a business rule (a new composite source, a different weekend policy,
new CRM weighting), you now have to update it in both places. `configs.js`
also duplicates `config/*.yaml` for the same reason (no YAML parser bundled
into the Worker). This is a deliberate, documented cost of getting genuinely
free 2-minute freshness — not an oversight.

**What GitHub Actions still does:** `.github/workflows/refresh.yml` no
longer runs on a schedule at all — it only fires on `workflow_dispatch` or
when you push a change to `templates/`, `config/`, `dashboards/`,
`scripts/`, or `functions/`. It regenerates the static HTML shell (with a
baked-in fallback payload for first paint) and redeploys it to Cloudflare
Pages, including the `functions/` directory — occasional, not continuous,
which is what keeps this off GitHub's billed minutes.

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
  scripts/
    generate.py           CLI entrypoint
  functions/              Cloudflare Pages Functions — serve live KV data at
                          /<dashboard>/data.json, same domain as the HTML so
                          they inherit the same Cloudflare Access gate
  worker/                 bison-dashboard-refresher: the Cloudflare Worker
                          that actually pulls Odoo every 2 minutes (JS port
                          of dashboards/*.py — see Architecture above)
    src/xmlrpc.js          hand-rolled XML-RPC codec (no DOMParser in Workers)
    src/*.test.mjs         unit tests, run with `npm test`
    src/*.livetest.mjs     tests against live Odoo + a diff against Python
                          output, run with `npm run livetest`
  .github/workflows/
    refresh.yml            push/manual-triggered build + Cloudflare Pages deploy
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

Run once:

```bash
.venv/Scripts/python scripts/generate.py --config config/sales_graph.yaml
# or: --all to build every config in config/
```

Open `output/sales_graph/index.html` in a browser to check it. Because the
page fetches `./data.json` on a relative path, opening it as a bare `file://`
works for the first paint (data is baked into the page at generation time)
but the live-refresh fetch needs the two files served from the same origin —
for local testing, `python -m http.server` from inside `output/sales_graph/`
is enough.

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

**Important since the live-refresh Worker landed:** a config dropped into
`config/` on its own only gets refreshed when the GitHub Actions pipeline
runs (i.e. when you push, or trigger it manually) — it does **not**
automatically get the Worker's 2-minute live refresh, because the Worker's
`configs.js` only knows about the two dashboards hardcoded into it. A new
dashboard needs its config ported into `worker/src/configs.js` too (and any
new composite source into `worker/src/specialSources.js` /
`crmSources.js`) to join the 2-minute cadence — see the Architecture
tradeoff note above.

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

Two separate deploys keep this live — they change on different, mostly
unrelated cadences.

**The live-refresh Worker** (`worker/`) is the thing actually pulling Odoo
every 2 minutes. To (re)deploy it after a code change:

```bash
cd worker
npm test           # unit tests — no network, no credentials needed
npm run livetest   # tests against live Odoo + diffs the JS output against
                    # the Python output — run this after any change to the
                    # aggregation logic, before deploying
npx wrangler deploy
```

It needs 4 secrets (`ODOO_URL`/`ODOO_DB`/`ODOO_USERNAME`/`ODOO_PASSWORD`),
set once via `wrangler secret put <NAME>` (already done) — and one KV
namespace (`DASHBOARD_DATA`, id in `worker/wrangler.toml`) that's also bound
to the Pages project (in the top-level `wrangler.toml`) so the Pages
Functions in `functions/` can read what the Worker writes. `workers_dev` and
`preview_urls` are explicitly disabled — this Worker has no public HTTP
route at all, only its Cron Trigger; verify that stayed true after any
config change (`curl` its `*.workers.dev` URL should just fail to resolve,
not 404 — a 404 would mean the route came back).

**The GitHub Actions pipeline** (`.github/workflows/refresh.yml`) only
redeploys the static HTML/CSS/JS shell — it fires on push to
`templates/`/`config/`/`dashboards/`/`scripts/`/`functions/`, or manually via
`workflow_dispatch`, **not on a schedule**. It needs these repo secrets:

- `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_PASSWORD` — used only for the
  baked-in fallback payload at first paint, same as your `.env`
- `CLOUDFLARE_API_TOKEN` — a token scoped to **Cloudflare Pages: Edit**
- `CLOUDFLARE_ACCOUNT_ID` — `5d255a554c200f7a0de4cd895d4d4073`

**Live now:**
- **https://bison-dashboards.pages.dev/sales_graph/**
- **https://bison-dashboards.pages.dev/sales_dashboard/**

Both are gated by Cloudflare Access — confirmed by curling `/data.json` on
each and getting redirected to the Access login, not a 200 with data.
Whoever administers Access should confirm the policy is scoped to the right
people; I didn't configure that policy myself.

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
