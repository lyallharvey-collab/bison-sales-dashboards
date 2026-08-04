# Implementation plan — per-division "thermometer" panel

> **STATUS: IMPLEMENTED (2026-08-04).** Kept for the reasoning, not as a to-do
> list. The living documentation is the "division meters" section of `README.md`;
> if the two ever disagree, the README wins. Lyall's answers to §8 are recorded
> there. The one step still outstanding is the deploy itself (`git push`) and a
> human confirming the live page.

Hand this to a fresh Claude Code session in the `sales-dashboards` project. It is
written to be self-contained: you should not need the conversation it came from.

**Goal:** bring back the per-division WIG scoreboard Bison ran in Excel until
2023 — Machinery / Consumables / SAS, each showing actual against target — as a
panel on the live Odoo dashboard.

**Why it matters:** the current dashboard only shows company totals. The 2023
sheet showed why that hides things: overall 72% of target was *Machinery 72%,
Consumables 7%, SAS 231%*. Three completely different stories averaging into one
unremarkable number. That is the value here — not the chart, the disaggregation.

---

## 1. Orientation (read this before touching anything)

```
sales-dashboards/
  dashboards/*.py      Python data layer — local preview + the reference the JS
                       is diff-tested against. NOT used in production.
  lib/*.js             THE production data layer. Imported by the Pages
                       Functions. JSON-RPC to Odoo, aggregation, view derivations.
  functions/<name>/data.json.js
                       Cloudflare Pages Function. The only thing that talks to
                       Odoo in production. Queries on request.
  static/views.js      Client-side view derivations + kiosk/desktop mode.
  templates/*.j2       Jinja2 + Chart.js. dashboard = single chart,
                       multi_dashboard = 4-panel grid.
  config/*.yaml        Dashboard definitions (drives the HTML shell).
  PLAN-division-meters.md   <- this file
```

**Architecture in one line:** GitHub Actions deploys a data-less HTML shell to
Cloudflare Pages; the page fetches `/<dashboard>/data.json` on load and every
120s; that Function queries Odoo live. There is no cron, no KV, no cache.

**Commands:**

```bash
npm test                                              # unit tests, no creds needed
npm run livetest                                      # live Odoo + JS-vs-Python parity
npm run cpucheck                                      # CPU budget per request
.venv/Scripts/python scripts/generate.py --all        # local preview WITH real data
.venv/Scripts/python scripts/generate.py --all --shell # what CI builds (no Odoo)
npx wrangler pages dev output --port 8811             # exercises the real Function
git push                                              # CI deploys on push to main
```

Read `README.md` for the full picture, especially "Two things to know about the
current design".

---

## 2. The data mapping — RESOLVED, verified against live Odoo

This was the blocker. It is answered. Do not re-derive it.

| Division | `crm.team` id | Daily target field on `x_daily_sales_targets` |
|---|---|---|
| Machinery | **5** (`MACHINERY`) | `x_studio_machinery_daily_target` |
| Consumables | **7** (`CONSUMABLES`) | `x_studio_consumables_daily_target` |
| SAS (service) | **6** (`SAS`) | `x_studio_sas_daily_target` |

There are exactly three `crm.team` records, so this is a clean 1:1 mapping and
the three divisions are the whole business.

**Ignore the other `x_studio_*_daily_target` columns** (ARB, BC, CC, GBH, PCD,
RHB, SRH, Grange). They are per-salesperson, not divisions — note the field
labels disagree with the field names (`x_studio_cc_daily_target` is labelled
"CJB Daily Target", `x_studio_gbh_daily_target` is "LMJ"), i.e. initials.

**Both actuals sources carry `team_id`,** verified with live records:
- `sale.order.team_id` — for Orders
- `bison_core.account_move_gp_report.team_id` — for Invoiced

So per-division actuals are a `read_group` on `team_id`. No joins, no new models.

---

## 3. Design decisions

### Use a CSS/DOM meter, NOT Chart.js

A thermometer is not a chart, it is a **meter** — one ratio against a limit. Do
it as a `div` track with a fill whose height is a percentage. Reasons:

- Chart.js has no gauge type; faking one with a stacked bar is fighting the tool.
- CSS transitions give smooth GPU-accelerated animation for free, and honour
  `prefers-reduced-motion` trivially.
- No canvas per division: less CPU, no canvas-sizing headaches, and Claude
  Design can restyle it without touching chart config.

Add a new panel type — suggest `type: meter_group` — rendered in
`templates/multi_dashboard.html.j2` alongside `line_chart` / `kpi` / `table`.

### Targets must be TO-DATE, not full-month

This is settled precedent in this codebase and getting it wrong produces a
misleading number. Compare month-to-date actual against **month-to-date target**;
show the full-month target as a small annotation. See `summarise()` in
`static/views.js` for the existing pattern (`targetToDate` vs `targetFinal`) and
the README's note on why. A £4.8m actual against a £10.6m full-year target reads
as 45% when the honest figure is 77% of pace.

### Over 100% — recommended treatment

SAS hit 231% in the 2023 data, so this is not hypothetical.

**Do:** keep all three tubes on the **same 0–100% scale** so they stay visually
comparable, cap the *fill* at 100%, and signal overflow explicitly:

- fill capped at the top of the tube
- the tube cap switches to the "good" status colour (`#0ca30c`) when over target
- a small badge shows the true figure, e.g. `231%` or `+131%`
- the numeric percentage is **always** rendered as text, so the value is never
  gated by the visual

**Do not** give each tube its own scale (e.g. max = that division's own
percentage). It makes the three non-comparable, which defeats the point of
putting them side by side.

### Animation — you were invited to be creative; here are the limits

- **One-shot transitions only.** Animate the fill rising from its previous value
  to the new one on change (~600–900ms, ease-out). This is a wall display: a
  looping pulse or glow will be maddening within an hour and is a genuine
  vestibular-comfort issue.
- **Only animate when the value actually changed.** The page refetches every
  120s; re-animating identical numbers makes the wall twitch constantly.
- **Honour `prefers-reduced-motion: reduce`** — drop to no transition.
- A one-shot emphasis when a division *crosses* 100% is a nice touch. A
  permanent animated state is not.

Chart.js animation is globally disabled (`animation: false`) for kiosk
stability. A CSS-based meter sidesteps that entirely — another reason for it.

### Which actual — Orders or Invoiced?

The 2023 sheet just said "Actual" and is ambiguous. Recommend making it a config
option (`measure: orders | invoiced`) defaulting to **orders**, matching the
"what's coming in" emphasis of the existing Orders line. Both are available per
team, so this costs nothing.

---

## 4. Implementation steps

### 4.1 Data layer — JS (production)

New file `lib/divisionSources.js`:

```js
export const DIVISIONS = [
  { key: 'machinery',   label: 'Machinery',   teamId: 5, targetField: 'x_studio_machinery_daily_target' },
  { key: 'consumables', label: 'Consumables', teamId: 7, targetField: 'x_studio_consumables_daily_target' },
  { key: 'sas',         label: 'SAS',         teamId: 6, targetField: 'x_studio_sas_daily_target' },
];
```

Export `divisionMeters(client, monthStart, monthEnd, today)` returning:

```js
[{ key, label, target_to_date, target_full, actual, pct }]   // + a TOTAL row
```

- **Targets:** ONE `read_group` on `x_daily_sales_targets` requesting all three
  target fields at once (not three calls — see the CPU note in §6), with
  `x_studio_date` between `monthStart` and today for to-date, and a second call
  to `monthEnd` for the full-month figure. Two calls total.
- **Actuals (orders):** `read_group` on `sale.order`, `fields: ['amount_untaxed']`,
  `groupby: ['team_id']`, domain `state = 'sale'` plus the date range. Mirror
  whatever `lib/specialSources.js` does for the company Orders line so the
  numbers reconcile — check whether proformas (`machinary_stage_id = 2`) should
  be included; the company line includes them.
- **Actuals (invoiced):** `read_group` on `bison_core.account_move_gp_report`,
  `fields: ['aml_total_net']`, `groupby: ['team_id']`, same domain as the
  existing Invoiced series.
- Apply the **same weekend folding** as the rest of the dashboard if you go
  daily-granular. If you only need month-to-date scalars, you do not need it.
- Register in `lib/buildMultiDashboard.js` as a new panel builder, and add the
  panel type to the `if/else` chain in `buildMultiDashboardPayload`.

### 4.2 Data layer — Python (the reference)

Mirror it in `dashboards/division_sources.py` + a branch in
`dashboards/multi_build.py`. This is what `npm run livetest` diffs against, and
it is how you prove the JS is right. Also add a shell branch in
`dashboards/shell_build.py` so `--shell` renders the panel structure with no data.

### 4.3 Config

Add the panel to **both**:
- `config/sales_dashboard.yaml` (drives the HTML shell)
- `lib/configs.js` (drives the live data)

They are not mechanically synced. Changing one and not the other is the single
easiest mistake to make in this repo.

### 4.4 Template

In `templates/multi_dashboard.html.j2`:
- add a `{% elif panel.type == 'meter_group' %}` branch rendering a container
- add `renderMeterGroupPanel(panel)` to the JS, called from `applyPayload`
- CSS: track + fill + label + value + percentage badge. Keep it **functional,
  not designed** — plain, so Claude Design can restyle it. Follow the existing
  convention: everything sized with `calc(Xvh * var(--scale))` so the zoom
  control still works.

---

## 5. Verification — do all of these

```bash
npm test            # must pass
npm run livetest    # must print "OVERALL: MATCH" — proves JS == Python
npm run cpucheck    # must stay well under 10ms; warns above 50%
```

Then exercise the real production path locally:

```bash
cp .env .dev.vars                                        # gitignored
.venv/Scripts/python scripts/generate.py --all --shell
cp -r functions output/
npx wrangler pages dev output --port 8811
curl -s http://127.0.0.1:8811/sales_dashboard/data.json | head -c 600
```

**Sanity-check the numbers, don't just check it renders:** the three divisions
must sum to the company total already on the dashboard. In the 2023 sheet they
summed exactly (£34,973.14 + £6,459.57 + £2,706.05 = £44,138.76). If they don't
reconcile against the existing Orders/Invoiced figures, the domain is wrong —
most likely proformas or the `state` filter.

After deploying, confirm Cloudflare Access still gates everything:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://bison-dashboards.pages.dev/sales_dashboard/data.json
# MUST be 302 (redirect to Access login), never 200
```

---

## 6. Gotchas that will bite you

1. **Dual config.** `config/*.yaml` and `lib/configs.js` both need every change.
2. **Dual data layer.** `dashboards/*.py` and `lib/*.js` are independent
   implementations. `npm run livetest` is the only thing keeping them honest.
3. **10ms CPU ceiling.** Cloudflare's free tier allows 10ms CPU per Function
   invocation and kills anything over — it silently broke the dashboard once
   already (`outcome: "exceededCpu"`). Currently ~0.6ms, ~18x headroom, so a new
   panel is affordable. But: **request multiple measures in ONE `read_group`
   rather than one call per measure**, and never pull rows to aggregate them in
   JS (pulling 734 `crm.lead` rows to compute 5 numbers is what blew the budget).
   Run `npm run cpucheck` after.
4. **`summarise()` runs on the RAW payload; `applyView()` is display-only.** Keep
   that separation or day counting and run-rate maths break.
5. **The zero origin.** Cumulative/projection views prepend a blank-labelled zero
   point, so anything indexing into a *drawn* series must offset by
   `originOffset`. Not relevant to a meter, but relevant if you touch charts.
6. **`is_reference` is coupled to `extend`** in the builders. If you ever want a
   reference line that stops at today, decouple them first or the target line
   will render solid and filled instead of dashed.
7. **You cannot `curl` production to check data** — Cloudflare Access returns 302
   before the Function runs. Verify via `wrangler pages dev`, then ask a human to
   confirm the live page.
8. **`wrangler delete` and other Workers commands** fail in this directory
   because the root `wrangler.toml` marks it a Pages project. Pass
   `--cwd <parent dir>` if you need them.
9. **The browser screenshot tool was unreliable** in the originating session.
   Verify rendering by inspecting the DOM and chart objects
   (`document.querySelectorAll`, `chart.data.datasets`) rather than trusting a
   picture — and note `chartArea` reads as zero-width when the pane isn't
   compositing, which is a tooling artefact, not a layout bug.

---

## 7. Non-negotiable rules

These are correctness, not taste. The `dataviz` skill covers them in full — load
it before writing any chart code.

- **Never two y-axes on one plot.** Two measures of different scale → two charts,
  small multiples, or index both to a common base.
- **Colour follows the entity, not rank.** Target is purple, Orders is blue,
  everywhere. A filter that removes a series must not repaint the survivors.
- **Run the palette validator on any new colour** —
  `node scripts/validate_palette.js "<hex,hex>" --mode light` in the dataviz
  skill directory. Do not eyeball colourblind safety. The current palettes pass;
  keep them passing. (`#42a5f5` was already replaced for failing 3:1 contrast.)
- **Status colours are reserved** for good/warning/serious/critical and ship with
  a label, never colour alone. `good #0ca30c`, `critical #d03b3b`.
- **Text wears text tokens, not the series colour.** A coloured dot beside a
  label carries identity; the text stays in normal ink.
- **Legend always present for ≥2 series.** Identity is never colour-alone.
- **Do NOT reintroduce end-of-line direct labels** — tried, removed. They
  collided where lines converge and duplicated the legend row.
- **Gridlines are solid hairlines, never dashed.** Dashing means
  threshold/projection here.
- **One control row scoping everything**, never per-panel filters.
- **Security:** Odoo credentials live only as Cloudflare Pages secrets. Never add
  them to GitHub, never commit `.env` or `.dev.vars`, and re-check the Access
  gate after adding any route.

---

## 8. Open questions for Lyall — ANSWERED

1. **Orders or Invoiced** as "Actual"? → **Orders**, and it is configurable
   (`measure: orders | invoiced`). Both paths are implemented and exercised
   against live Odoo.
2. **Month-to-date, or daily?** → **Daily**, as the starting point. `period: day
   | month` is a config knob, so switching later is a one-line change in two
   files, not a rewrite. Note the hunch in the original question turned out to be
   supported: the 2023 sheet's £44,138.77 does sit right alongside the £42,400
   company *daily* target.
   - Daily brought one thing the plan hadn't anticipated:
     `x_daily_sales_targets` has **no weekend rows at all**, so a Saturday would
     divide by a zero target. The window rolls back to Friday, matching the fold
     the charts already apply.
   - The §3 "targets must be TO-DATE" rule still holds and still matters — it is
     what `period: month` does. For `period: day` it degenerates to "today's
     target", which is the same principle at one day's granularity.
3. **Should the TOTAL tube be shown?** → **Yes**, four tubes, as in the 2023
   sheet. Its target comes from `x_studio_company_daily_target` rather than the
   sum of the three, so this page and the Sales Graph cannot disagree about what
   the company target is.
4. **Where on the dashboard?** → **Its own page**, `/division_meters/`, with a
   rotation of several dashboards in mind. That is why the render path had to stop
   depending on `requestAnimationFrame` — see the animation note in `README.md`:
   rAF never fires in a hidden tab, so a rotation loading pages in the background
   painted empty tubes.

### What §5's verification actually produced

- `npm test` — passes, plus a new `lib/meters.test.mjs` covering the mapping, the
  weekend rollback, the over-100% case, the unattributed remainder and zero
  targets.
- `npm run livetest` — **OVERALL: MATCH**.
- `npm run cpucheck` — `division_meters` is **0.164 ms of the 10 ms budget
  (1.6%)** on 6 Odoo calls, the cheapest of the three dashboards.
- **Reconciliation, the check that mattered:** divisions month-to-date summed to
  £36,708.80 (orders) and £26,198.47 (invoiced), matching the Sales Graph's
  existing cumulative figures **to the penny** — so the domains are right.
- Exercised through `wrangler pages dev`, i.e. the real Pages Function.
- Rendering verified by DOM inspection, not screenshots — gotcha #9 held: the
  screenshot tool still fails with "the Browser pane is not displayed".
