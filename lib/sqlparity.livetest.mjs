/**
 * Diff the live dashboard against the ORIGINAL Dashboard Ninja SQL.
 *
 * WHY THIS EXISTS, and why `npm run livetest` was not enough: that check proves
 * the JS and the Python agree WITH EACH OTHER. Twice now they have agreed
 * perfectly while BOTH being wrong — the refund sign and the month-start
 * weekend fold were found by a human exporting the Ninja graph to xlsx and
 * diffing by hand, and the parity suite stayed green throughout. This file is
 * the independent source of truth those bugs slipped past.
 *
 * So: nothing here imports the aggregation logic. The four series are rebuilt
 * from raw read_group calls that transcribe the SQL directly. If this and
 * lib/buildSalesGraph.js agree, two independent readings of the business rules
 * agree — which is a real check.
 *
 * Reference SQL: the corrected version (Aug 2026). Two things it fixed:
 *   - service contracts are found by a LINE-LEVEL JOIN
 *     (account_move_line -> sale_order_line_invoice_rel -> sale_order_line ->
 *      sale_order, where is_subscription OR subscription_id IS NOT NULL)
 *     instead of `invoice_origin in (select code from sale_subscription)`,
 *     which read a legacy table holding only pre-migration SUB-coded contracts
 *     and so under-counted by every contract created since.
 *   - refunds are subtracted: `case when move_type = 'out_invoice'
 *     then amount_untaxed else 0 - amount_untaxed end`.
 *
 * TWO DELIBERATE DIVERGENCES, both asserted rather than ignored:
 *
 * 1. WEEKENDS. The SQL joins activity onto rows of x_daily_sales_targets, which
 *    has no weekend rows, so weekend orders are silently dropped. The dashboard
 *    folds them onto a business day instead. The difference between the two
 *    series must therefore equal the folded weekend money EXACTLY and nothing
 *    else — which is a stronger statement than "they match", and is what this
 *    file asserts. The fold rule is restated here independently on purpose.
 *
 * 2. SERVICE-CONTRACT POPULATION. 20 invoices in 2026 (net GBP 5,800.64) carry a
 *    subscription order in invoice_origin but have NO row in
 *    sale_order_line_invoice_rel, so the SQL's line-level join misses them and
 *    the dashboard's invoice_origin match catches them. Verified: e.g. invoice
 *    187375, origin 188656, whose order IS is_subscription, whose single line
 *    has sale_line_ids = []. The dashboard is MORE complete here, so this file
 *    reports the gap and does not fail on it. None fall in August 2026, which
 *    is why the two agree exactly this month.
 */
import { readFileSync } from 'node:fs';
import { OdooClient } from './odooClient.js';
import { buildSalesGraphPayload } from './buildSalesGraph.js';
import { SALES_GRAPH_CONFIG } from './configs.js';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const newClient = () => new OdooClient({
  url: env.ODOO_URL, db: env.ODOO_DB, username: env.ODOO_USERNAME, password: env.ODOO_PASSWORD,
});

const iso = (d) => d.toISOString().slice(0, 10);
const money = (v) => (v < 0 ? '-' : '') + '£' + Math.abs(v).toLocaleString('en-GB', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const today = new Date();
const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
const todayIso = iso(today);

// --- the SQL's own components, transcribed ---------------------------------
const inMonth = (field) => [
  [field, '>=', iso(monthStart)], [field, '<=', iso(monthEnd)],
];

async function byDay(client, model, domain, dateField, measure) {
  const groups = await client.readGroup(model, [...domain, ...inMonth(dateField)],
    [measure], [`${dateField}:day`], false);
  const out = new Map();
  for (const g of groups) {
    const rng = g.__range && g.__range[`${dateField}:day`];
    if (rng && rng.from) out.set(String(rng.from).slice(0, 10), g[measure] || 0);
  }
  return out;
}

/** `case when move_type = 'out_invoice' then amount_untaxed else 0 - amount_untaxed end` */
async function signedTotal(client, domain) {
  const groups = await client.readGroup('account.move', domain, ['amount_untaxed'], ['move_type'], false);
  let net = 0;
  for (const g of groups) {
    const mt = Array.isArray(g.move_type) ? g.move_type[0] : g.move_type;
    const amt = g.amount_untaxed || 0;
    net += mt === 'out_refund' ? -amt : amt;
  }
  return net;
}

const MOVE_BASE = [
  ['state', '=', 'posted'],
  ['move_type', 'in', ['out_invoice', 'out_refund']],
  ...inMonth('invoice_date'),
];
// The SQL's EXISTS(...). account.move.line.sale_line_ids IS the
// sale_order_line_invoice_rel table the SQL joins through.
const RELATIONAL = ['|',
  ['invoice_line_ids.sale_line_ids.order_id.is_subscription', '=', true],
  ['invoice_line_ids.sale_line_ids.order_id.subscription_id', '!=', false]];

async function sqlComponents(client) {
  const [axisRows, confirmed, proforma, invoiced, svcContracts] = await Promise.all([
    client.searchRead('x_daily_sales_targets',
      [['x_studio_date', '>=', iso(monthStart)], ['x_studio_date', '<=', todayIso]],
      { fields: ['x_studio_date', 'x_studio_company_daily_target', 'x_studio_company_daily_breakeven'],
        order: 'x_studio_date asc', limit: 100 }),
    byDay(client, 'sale.order', [['state', '=', 'sale']], 'date_order', 'amount_untaxed'),
    byDay(client, 'sale.order',
      [['state', 'in', ['draft', 'sent']], ['machinary_stage_id', '=', 2]], 'date_order', 'amount_untaxed'),
    byDay(client, 'bison_core.account_move_gp_report',
      [['move_id.state', '=', 'posted'], ['move_id.move_type', 'in', ['out_invoice', 'out_refund']]],
      'sales_target_date', 'aml_total_net'),
    signedTotal(client, [...MOVE_BASE, ...RELATIONAL]),
  ]);
  return { axisRows, confirmed, proforma, invoiced, svcContracts };
}

/** Cumulative window sums over the target rows, exactly as the SQL does. */
function sqlSeries({ axisRows, confirmed, proforma, invoiced, svcContracts }) {
  const axis = axisRows.map((r) => r.x_studio_date);
  const lumpDay = axis[0];   // SQL: min(x_studio_date) of the month
  const out = { Target: new Map(), Breakeven: new Map(), Orders: new Map(), Invoiced: new Map() };
  let t = 0, b = 0, o = 0, i = 0;
  for (const r of axisRows) {
    const d = r.x_studio_date;
    t += r.x_studio_company_daily_target || 0;
    b += r.x_studio_company_daily_breakeven || 0;
    o += (confirmed.get(d) || 0) + (proforma.get(d) || 0) + (d === lumpDay ? svcContracts : 0);
    i += invoiced.get(d) || 0;
    out.Target.set(d, t); out.Breakeven.set(d, b); out.Orders.set(d, o); out.Invoiced.set(d, i);
  }
  return { axis, series: out, lumpDay };
}

/** Divergence 1, restated independently: weekend activity has no target row to
 * land on. The dashboard folds it back to that week's Friday — or FORWARD to the
 * first business day when rolling back would leave the month, which is the
 * month-start data loss fixed in Aug 2026. */
function weekendFoldTargets(axis, confirmed, proforma) {
  const business = new Set(axis);
  const folded = new Map();
  for (const d of new Set([...confirmed.keys(), ...proforma.keys()])) {
    const dt = new Date(d + 'T00:00:00Z');
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) continue;
    const amount = (confirmed.get(d) || 0) + (proforma.get(d) || 0);
    if (!amount) continue;
    let back = new Date(dt);
    do { back.setUTCDate(back.getUTCDate() - 1); } while ([0, 6].includes(back.getUTCDay()));
    const target = business.has(iso(back)) ? iso(back) : axis[0];
    folded.set(d, { amount, target });
  }
  return folded;
}

// --- run -------------------------------------------------------------------
console.log('=== dashboard vs the corrected Dashboard Ninja SQL ===');
console.log(`today (UTC) ${todayIso}   month ${iso(monthStart)}..${iso(monthEnd)}\n`);

// Read the SQL side, then the dashboard, then the SQL side again. This is a
// live production system: an order confirmed between the two reads shifts
// TODAY's column and would otherwise look like a bug. Verified once already —
// a £583.30 order landed at 10:11:42 mid-run and produced exactly that.
const before = await sqlComponents(newClient());
const dash = await buildSalesGraphPayload(newClient(), SALES_GRAPH_CONFIG, today);
const after = await sqlComponents(newClient());

const { axis, series, lumpDay } = sqlSeries(after);
const dashSeries = {};
for (const s of dash.series) dashSeries[s.label] = new Map(dash.labels.map((l, i) => [l, s.data[i]]));

const folded = weekendFoldTargets(axis, after.confirmed, after.proforma);
console.log(`service contracts (signed, whole month): ${money(after.svcContracts)} landing on ${lumpDay}`);
console.log(`weekend activity: ${folded.size
  ? [...folded].map(([d, f]) => `${d} ${money(f.amount)} -> ${f.target}`).join(', ')
  : 'none this month'}\n`);

// Expected cumulative offset on each day: weekend money folded onto a day <= d,
// which the SQL drops entirely.
const offsetUpTo = (day) => [...folded.values()]
  .filter((f) => f.target <= day).reduce((a, f) => a + f.amount, 0);

const moved = Math.abs((before.confirmed.get(todayIso) || 0) - (after.confirmed.get(todayIso) || 0)) > 0.005
  || Math.abs((before.proforma.get(todayIso) || 0) - (after.proforma.get(todayIso) || 0)) > 0.005;

let failures = 0;
for (const name of ['Target', 'Breakeven', 'Orders', 'Invoiced']) {
  console.log(`--- ${name} ---`);
  for (const d of axis) {
    const sql = series[name].get(d);
    const got = dashSeries[name].get(d);
    if (got === undefined || got === null) { console.log(`  ${d}  (not on the dashboard axis)`); continue; }
    const expectedOffset = name === 'Orders' ? offsetUpTo(d) : 0;
    const diff = got - sql - expectedOffset;
    const live = d === todayIso && moved;
    const ok = Math.abs(diff) < 0.01;
    const note = ok ? '' : (live ? '  LIVE MOVEMENT during the run — not a mismatch' : '  <-- MISMATCH');
    if (!ok && !live) failures++;
    console.log(`  ${d}  sql ${money(sql).padStart(14)}  dash ${money(got).padStart(14)}`
      + (expectedOffset ? `  (+${money(expectedOffset)} folded weekend)` : '')
      + (ok ? '  ok' : `  diff ${money(diff)}${note}`));
  }
}

console.log('\n--- service-contract population (divergence 2, reported not enforced) ---');
const c = newClient();
const [relIds, originIds] = await Promise.all([
  c.searchRead('account.move', [...MOVE_BASE, ...RELATIONAL], { fields: ['id'], limit: 2000 }),
  (async () => {
    const names = (await c.searchRead('sale.order', [['is_subscription', '=', true]],
      { fields: ['name'], limit: 10000 })).map((r) => r.name);
    return c.searchRead('account.move', [...MOVE_BASE, ['invoice_origin', 'in', names]],
      { fields: ['id'], limit: 2000 });
  })(),
]);
const rel = new Set(relIds.map((r) => r.id));
const org = new Set(originIds.map((r) => r.id));
const onlyOrigin = [...org].filter((i) => !rel.has(i));
const onlyRel = [...rel].filter((i) => !org.has(i));
console.log(`  SQL line-level join: ${rel.size} invoices`);
console.log(`  dashboard invoice_origin match: ${org.size} invoices`);
console.log(`  caught by the dashboard only (no rel row): ${onlyOrigin.length}`);
console.log(`  caught by the SQL only (blank/multi invoice_origin): ${onlyRel.length}`
  + (onlyRel.length ? '  <-- the dashboard is MISSING money; investigate' : ''));
if (onlyRel.length) failures++;

console.log(`\n=== ${failures === 0 ? 'MATCHES THE SQL' : `${failures} MISMATCH(ES) — DO NOT SHIP`} ===`);
if (moved) console.log("(today's column moved during the run; the book was open)");
process.exit(failures === 0 ? 0 : 1);
