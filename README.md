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

You said there's no always-on PC by the screens — the TV is just a smart-TV
browser — and that you want the page to live-refresh (fetch + redraw) rather
than do a full reload, hosted on Cloudflare. Putting those together:

```
GitHub Actions (cron, every ~10 min)
  → runs generate.py: pulls Odoo via OdooClient, computes cumulative sums
    in pandas, writes output/<dashboard>/index.html + data.json
  → deploys output/ to Cloudflare Pages (static hosting)

Cloudflare Pages (public URL)
  → TV browser opens the URL ONCE and leaves it open
  → page JS re-fetches data.json every `refresh_seconds` and redraws
    Chart.js in place — no reload, no flash
```

**One assumption worth flagging:** the actual Odoo-fetching code runs in
GitHub Actions, not in a Cloudflare Worker. Cloudflare's Python Workers
runtime (Pyodide-based) doesn't give `xmlrpc.client` a working transport for
real outbound sockets, so the XML-RPC calls this needs can't run there
directly — and reimplementing the data layer in JS would mean maintaining two
codebases instead of one. GitHub Actions is free, needs no server to
maintain, and keeps everything in the Python/pandas/OdooClient shape you
asked for. Cloudflare's job is purely to host and serve the static output. If
you'd rather explore a pure-Workers rewrite instead, say so and we can revisit
this — but it's a bigger lift for no real benefit here.

Practical note: GitHub's schedule is best-effort — a `*/10` cron can slip to
15-20 minutes under load. Fine for a wall dashboard; not a guarantee.

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
  .github/workflows/
    refresh.yml            scheduled build + Cloudflare Pages deploy
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

**When it doesn't fit that shape** — e.g. the Sales Graph's "Orders" line,
which is really three sums combined (confirmed orders + proformas +
a monthly subscription-invoicing lump, all by different domains/models) before
the running total is taken — write a small Python function in
`dashboards/special_sources.py`, register it in `COMPOSITE_SOURCES`, and
reference it from the config as `source: my_function_name` instead of
`source: read_group`. `sales_orders_component` is the existing example to
copy.

## Running on a schedule

**GitHub Actions (what's wired up):** `.github/workflows/refresh.yml` runs on
a cron and on manual dispatch. It needs these repo secrets:

- `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_PASSWORD` — same as your `.env`
- `CLOUDFLARE_API_TOKEN` — a token scoped to **Cloudflare Pages: Edit** for your account
- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard sidebar

**Cloudflare Pages setup — done, live now:**

Using the already-authenticated `wrangler` CLI on this machine, the
`bison-dashboards` Pages project has been created and the current
`output/` deployed as a one-off manual push:

- **https://bison-dashboards.pages.dev/** — root page links to each dashboard
- **https://bison-dashboards.pages.dev/sales_graph/** — the Sales Graph, live now, confirmed rendering with real data

Account: `Lyallharv23@gmail.com's Account`, account ID `5d255a554c200f7a0de4cd895d4d4073`
(you'll need this ID for the GitHub Actions secret below).

That manual deploy won't refresh itself, though — for the recurring
GitHub Actions job in `refresh.yml` to take over, you still need to:

1. Push this repo to GitHub (it isn't one yet — I only deployed the static
   output, I didn't create a git repo or push anything anywhere).
2. Create a Cloudflare API token scoped to **Cloudflare Pages: Edit**
   (Cloudflare dashboard → My Profile → API Tokens → Create Token). My local
   `wrangler` session is logged in via OAuth, which isn't something CI can
   use — Actions needs its own token.
3. Add repo secrets (Settings → Secrets and variables → Actions):
   `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_PASSWORD`,
   `CLOUDFLARE_API_TOKEN` (from step 2), `CLOUDFLARE_ACCOUNT_ID` (from above).
4. First scheduled or manually-triggered Action run takes over refreshing it.

Until step 4 is done, the site is live but frozen at whatever data was in
`output/` at the last manual `wrangler pages deploy`.

**Privacy:** Cloudflare Pages URLs are public by default. This dashboard is
company sales figures, not customer PII, but you may still want to gate it —
Cloudflare Access (free for a handful of users) can put a login wall in front
of the Pages project with no code changes, or you can rely on the URL being
unguessable. Your call; not built in yet.

## Pointing a screen at it

Any smart-TV/kiosk browser: open the Pages URL and leave the tab open.
- Disable the TV's screensaver/sleep timer for that input/app.
- The page redraws its data every `refresh_seconds` (5 min by default)
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
