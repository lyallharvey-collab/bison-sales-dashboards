/**
 * Decompose the Sales Graph totals into the numbers behind them, straight from
 * Odoo, and reconcile against what the dashboard reports.
 *
 * Run: node lib/drilldown.mjs
 */
import { readFileSync } from 'node:fs';
import { OdooClient } from './odooClient.js';
import { buildDashboardPayload } from './index.js';
import { monthBounds, businessDaysInRange, isoDate, isWeekend } from './dates.js';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const client = new OdooClient({
  url: env.ODOO_URL, db: env.ODOO_DB, username: env.ODOO_USERNAME, password: env.ODOO_PASSWORD,
});

const gbp = (v) => '£' + Number(v || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol;
const PROFORMA_STAGE_ID = 2;

const now = new Date();
const [monthStart, monthEnd] = monthBounds(now);
const bdays = businessDaysInRange(monthStart, now);
console.log(`month ${isoDate(monthStart)} .. ${isoDate(monthEnd)}   business days so far: ${bdays.map(isoDate).join(', ')}\n`);

// Helper: per-day sums keyed by ISO date, over the whole month so far INCLUDING
// weekends — so we can see anything the business-day axis leaves out.
async function perDay(model, domain, dateField, measure) {
  const groups = await client.readGroup(
    model,
    [...domain, [dateField, '>=', isoDate(monthStart)], [dateField, '<=', isoDate(now)]],
    [measure], [`${dateField}:day`], false,
  );
  const out = new Map();
  for (const g of groups) {
    const rng = g.__range && g.__range[`${dateField}:day`];
    if (!rng || !rng.from) continue;
    out.set(String(rng.from).slice(0, 10), g[measure] || 0);
  }
  return out;
}

// ---------------------------------------------------------------- 1. targets
console.log('='.repeat(92));
console.log('1. TARGET / BREAKEVEN  — from x_daily_sales_targets');
console.log('='.repeat(92));
const tRows = await client.searchRead('x_daily_sales_targets',
  [['x_studio_date', '>=', isoDate(monthStart)], ['x_studio_date', '<=', isoDate(now)]],
  { fields: ['x_studio_date', 'x_studio_company_daily_target', 'x_studio_company_daily_breakeven'], limit: 100, order: 'x_studio_date asc' });
console.log('  date        weekend?   daily target      daily breakeven');
let tSum = 0, bSum = 0;
for (const r of tRows) {
  const d = new Date(r.x_studio_date + 'T00:00:00Z');
  const wk = isWeekend(d);
  if (!wk) { tSum += r.x_studio_company_daily_target || 0; bSum += r.x_studio_company_daily_breakeven || 0; }
  console.log(`  ${r.x_studio_date}  ${wk ? 'WEEKEND ' : '        '}  ${gbp(r.x_studio_company_daily_target).padStart(14)}  ${gbp(r.x_studio_company_daily_breakeven).padStart(16)}${wk ? '   <- excluded' : ''}`);
}
console.log(`\n  business-day totals: target ${gbp(tSum)}   breakeven ${gbp(bSum)}`);

// ----------------------------------------------------------------- 2. orders
console.log('\n' + '='.repeat(92));
console.log('2. ORDERS  — three components summed, then cumulated');
console.log('='.repeat(92));
const confirmed = await perDay('sale.order', [['state', '=', 'sale']], 'date_order', 'amount_untaxed');
const proforma = await perDay('sale.order',
  [['state', 'in', ['draft', 'sent']], ['machinary_stage_id', '=', PROFORMA_STAGE_ID]], 'date_order', 'amount_untaxed');

// Subscription/service-contract invoicing: one monthly lump, landed on the
// first day that has activity (mirrors the original Dashboard Ninja SQL).
const subOrders = await client.searchRead('sale.order', [['is_subscription', '=', true]], { fields: ['name'], limit: 10000 });
const subNames = subOrders.map((o) => o.name);
const subGroups = subNames.length ? await client.readGroup('account.move',
  [['invoice_origin', 'in', subNames], ['move_type', 'in', ['out_invoice', 'out_refund']],
    ['state', '=', 'posted'], ['invoice_date', '>=', isoDate(monthStart)], ['invoice_date', '<=', isoDate(monthEnd)]],
  ['amount_untaxed'], [], false) : [];
const subTotal = subGroups.length ? (subGroups[0].amount_untaxed || 0) : 0;

const allDates = [...new Set([...confirmed.keys(), ...proforma.keys()])].sort();
console.log('  date        weekend?     confirmed       proforma        day total');
let ordSum = 0, weekendOrphan = 0;
for (const d of allDates) {
  const wk = isWeekend(new Date(d + 'T00:00:00Z'));
  const c = confirmed.get(d) || 0, p = proforma.get(d) || 0;
  const t = c + p;
  if (wk) weekendOrphan += t; else ordSum += t;
  console.log(`  ${d}  ${wk ? 'WEEKEND ' : '        '}  ${gbp(c).padStart(13)}  ${gbp(p).padStart(13)}  ${gbp(t).padStart(14)}${wk ? '  <- folds to prev Friday' : ''}`);
}
console.log(`\n  business-day orders (confirmed + proforma)  ${gbp(ordSum)}`);
console.log(`  subscription / service contracts (month)   ${gbp(subTotal)}   from ${subNames.length} subscription orders`);
console.log(`  EXPECTED ORDERS TOTAL                      ${gbp(ordSum + subTotal)}`);
if (weekendOrphan) {
  console.log(`\n  !! ${gbp(weekendOrphan)} fell on a weekend date this month.`);
}

// --------------------------------------------------------------- 3. invoiced
console.log('\n' + '='.repeat(92));
console.log('3. INVOICED  — bison_core.account_move_gp_report, by sales_target_date');
console.log('='.repeat(92));
const inv = await perDay('bison_core.account_move_gp_report',
  [['move_id.state', '=', 'posted'], ['move_id.move_type', 'in', ['out_invoice', 'out_refund']]],
  'sales_target_date', 'aml_total_net');
console.log('  date        weekend?      net total');
let invSum = 0, invWeekend = 0;
for (const d of [...inv.keys()].sort()) {
  const wk = isWeekend(new Date(d + 'T00:00:00Z'));
  const v = inv.get(d) || 0;
  if (wk) invWeekend += v; else invSum += v;
  console.log(`  ${d}  ${wk ? 'WEEKEND ' : '        '}  ${gbp(v).padStart(14)}${wk ? '  <- folds to prev Friday' : ''}`);
}
console.log(`\n  business-day invoiced total  ${gbp(invSum)}`);
if (invWeekend) console.log(`  !! ${gbp(invWeekend)} on weekend dates`);

// ------------------------------------------------------------ 4. reconcile
console.log('\n' + '='.repeat(92));
console.log('4. RECONCILIATION against what the dashboard reports');
console.log('='.repeat(92));
const sg = await buildDashboardPayload(env, 'sales_graph', now);
const lastIdx = (d) => { let i = -1; d.forEach((v, k) => { if (v !== null && v !== undefined) i = k; }); return i; };
const ai = Math.max(...sg.series.filter((s) => !s.is_reference).map((s) => lastIdx(s.data)));
const shown = {};
for (const s of sg.series) shown[s.key] = s.data[ai];

const checks = [];
const check = (name, ok, detail) => { checks.push(ok); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}  — ${detail}`); };
check('Target', near(shown.target, tSum), `dashboard ${gbp(shown.target)} vs Odoo ${gbp(tSum)}`);
check('Breakeven', near(shown.breakeven, bSum), `dashboard ${gbp(shown.breakeven)} vs Odoo ${gbp(bSum)}`);
check('Orders', near(shown.orders, ordSum + subTotal), `dashboard ${gbp(shown.orders)} vs Odoo ${gbp(ordSum + subTotal)}`);
check('Invoiced', near(shown.invoiced, invSum), `dashboard ${gbp(shown.invoiced)} vs Odoo ${gbp(invSum)}`);

console.log('\n' + '='.repeat(92));
const bad = checks.filter((c) => !c).length;
console.log(bad ? `${bad} MISMATCH(ES)` : `all ${checks.length} totals reconcile to Odoo`);
