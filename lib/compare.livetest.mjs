import { readFileSync } from 'node:fs';
import { OdooClient } from './odooClient.js';
import { buildSalesGraphPayload } from './buildSalesGraph.js';
import { buildMultiDashboardPayload } from './buildMultiDashboard.js';
import { SALES_GRAPH_CONFIG, SALES_DASHBOARD_CONFIG, DIVISION_METERS_CONFIG } from './configs.js';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const client = new OdooClient({
  url: env.ODOO_URL, db: env.ODOO_DB, username: env.ODOO_USERNAME, password: env.ODOO_PASSWORD,
});
const today = new Date();

console.log('today (UTC):', today.toISOString());

const jsSalesGraph = await buildSalesGraphPayload(client, SALES_GRAPH_CONFIG, today);
const jsSalesDashboard = await buildMultiDashboardPayload(client, SALES_DASHBOARD_CONFIG, today);
const jsDivisionMeters = await buildMultiDashboardPayload(client, DIVISION_METERS_CONFIG, today);

const pySalesGraph = JSON.parse(readFileSync(new URL('../output/sales_graph/data.json', import.meta.url), 'utf8'));
const pySalesDashboard = JSON.parse(readFileSync(new URL('../output/sales_dashboard/data.json', import.meta.url), 'utf8'));
const pyDivisionMeters = JSON.parse(readFileSync(new URL('../output/division_meters/data.json', import.meta.url), 'utf8'));

function closeEnough(a, b, tol = 0.01) {
  if (a === null && b === null) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  return Math.abs(a - b) < tol;
}

/**
 * CHURN. The Python payload was written minutes ago by a separate process; this
 * runs now. On a busy trading day the order book moves in between, and the
 * difference lands on TODAY's bucket — which looks exactly like a bug. Observed
 * repeatedly: a £12,473.75 order at 14:20:15, a £327.00 at 14:25:06.
 *
 * So rather than tolerate a fixed fudge, ask Odoo what actually changed since
 * the Python payload was generated. Anything written after that timestamp is
 * churn, and a difference no larger than the churn on today's bucket is
 * reported as churn instead of failing the run. A difference on any EARLIER
 * bucket, or one bigger than the churn, still fails.
 */
const pyGeneratedAt = pySalesGraph.generated_at;
const churnSince = pyGeneratedAt ? String(pyGeneratedAt).replace('T', ' ').slice(0, 19) : null;
let churnBudget = 0;
if (churnSince) {
  const groups = await client.readGroup('sale.order',
    [['write_date', '>', churnSince], ['state', 'in', ['sale', 'draft', 'sent']]],
    ['amount_untaxed'], [], false);
  const moved = groups.length ? Math.abs(groups[0].amount_untaxed || 0) : 0;
  const n = groups.length ? groups[0].__count : 0;
  churnBudget = moved;
  console.log(`churn since the Python payload (${churnSince}): ${n} order(s) touched, `
    + `£${moved.toLocaleString('en-GB', { minimumFractionDigits: 2 })} of movement`);
}

/** Index of the last bucket either side has a value for — "today" on a daily
 * axis, the current month on a monthly one. The only bucket churn can reach. */
function lastLiveIndex(js, py) {
  let i = -1;
  for (let k = 0; k < js.data.length; k++) {
    const a = js.data[k], b = py.data[k];
    if ((a !== null && a !== undefined) || (b !== null && b !== undefined)) i = k;
  }
  return i;
}

function compareSeriesArray(label, jsSeries, pySeries) {
  let allOk = true;
  if (jsSeries.length !== pySeries.length) {
    console.log(`  [${label}] series count mismatch: js=${jsSeries.length} py=${pySeries.length}`);
    return false;
  }
  for (let i = 0; i < jsSeries.length; i++) {
    const js = jsSeries[i], py = pySeries[i];
    // Scoped PER SERIES. This was previously declared outside the loop, so one
    // mismatching series reported every later series as failing too.
    let ok = true;
    if (js.key !== py.key) { console.log(`  [${label}] series[${i}] key mismatch`); allOk = false; continue; }
    if (js.data.length !== py.data.length) {
      console.log(`  [${label}] ${js.key}: data length mismatch js=${js.data.length} py=${py.data.length}`);
      allOk = false; continue;
    }
    const live = lastLiveIndex(js, py);
    for (let j = 0; j < js.data.length; j++) {
      if (closeEnough(js.data[j], py.data[j])) continue;
      const diff = Math.abs((js.data[j] || 0) - (py.data[j] || 0));
      if (j === live && diff <= churnBudget + 0.01) {
        console.log(`  [${label}] ${js.key}[${j}]: js=${js.data[j]} py=${py.data[j]} `
          + `diff £${diff.toFixed(2)} — CHURN (within £${churnBudget.toFixed(2)} moved since the Python run)`);
        continue;
      }
      console.log(`  [${label}] ${js.key}[${j}]: js=${js.data[j]} py=${py.data[j]} MISMATCH`);
      ok = false;
    }
    console.log(`  [${label}] ${js.key}: ${js.data.length} points, matches: ${ok}`);
    allOk = allOk && ok;
  }
  return allOk;
}

console.log('\n=== sales_graph ===');
let allOk = true;
if (JSON.stringify(jsSalesGraph.labels) !== JSON.stringify(pySalesGraph.labels)) {
  console.log('LABELS MISMATCH', jsSalesGraph.labels, pySalesGraph.labels);
  allOk = false;
} else {
  console.log(`labels match: ${jsSalesGraph.labels.length} business days`);
}
allOk = compareSeriesArray('sales_graph', jsSalesGraph.series, pySalesGraph.series) && allOk;

function compareMultiDashboard(name, jsPayload, pyPayload) {
console.log(`\n=== ${name} ===`);
let allOk = true;
for (const jsPanel of jsPayload.panels) {
  const pyPanel = pyPayload.panels.find((p) => p.id === jsPanel.id);
  if (!pyPanel) { console.log(`panel ${jsPanel.id}: NOT FOUND in python output`); allOk = false; continue; }
  if (jsPanel.type === 'line_chart') {
    if (JSON.stringify(jsPanel.labels) !== JSON.stringify(pyPanel.labels)) {
      console.log(`  [${jsPanel.id}] LABELS MISMATCH`);
      console.log('    js:', jsPanel.labels);
      console.log('    py:', pyPanel.labels);
      allOk = false;
    } else {
      console.log(`[${jsPanel.id}] labels match (${jsPanel.labels.length})`);
    }
    allOk = compareSeriesArray(jsPanel.id, jsPanel.series, pyPanel.series) && allOk;
  } else if (jsPanel.type === 'kpi') {
    const match = jsPanel.value === pyPanel.value;
    console.log(`[${jsPanel.id}] js=${jsPanel.value} py=${pyPanel.value} match=${match} (note: "this week" count can legitimately differ if run at a different moment)`);
  } else if (jsPanel.type === 'meter_group') {
    let ok = jsPanel.meters.length === pyPanel.meters.length
      && jsPanel.period_from === pyPanel.period_from
      && jsPanel.period_to === pyPanel.period_to
      && jsPanel.measure === pyPanel.measure;
    if (!ok) {
      console.log(`  [${jsPanel.id}] header mismatch: js=${jsPanel.measure}/${jsPanel.period_from}..${jsPanel.period_to} py=${pyPanel.measure}/${pyPanel.period_from}..${pyPanel.period_to}`);
    }
    console.log(`  window ${jsPanel.period_from}..${jsPanel.period_to}  measure=${jsPanel.measure}`);
    for (let i = 0; i < jsPanel.meters.length; i++) {
      const jm = jsPanel.meters[i], pm = pyPanel.meters[i] || {};
      // Every meter row is the CURRENT day (or month) by definition, so all of
      // them sit in the churn window — see the note on churnBudget above.
      const drift = Math.abs((jm.actual || 0) - (pm.actual || 0));
      const churned = drift > 0 && drift <= churnBudget + 0.01;
      const rowOk = jm.key === pm.key
        && closeEnough(jm.target, pm.target)
        && (closeEnough(jm.actual, pm.actual) || churned);
      if (!rowOk) {
        console.log(`  [${jsPanel.id}] ${jm.key} MISMATCH js=${JSON.stringify(jm)} py=${JSON.stringify(pm)}`);
        ok = false;
      } else if (churned) {
        console.log(`  [${jsPanel.id}] ${jm.key}: js=${jm.actual} py=${pm.actual} `
          + `diff £${drift.toFixed(2)} — CHURN (within £${churnBudget.toFixed(2)} moved since the Python run)`);
      }
      const pct = jm.pct === null ? 'n/a' : (jm.pct * 100).toFixed(1) + '%';
      console.log(`    ${jm.label.padEnd(12)} ${jm.actual.toFixed(2).padStart(12)} / ${jm.target.toFixed(2).padStart(12)} = ${pct.padStart(8)}`);
    }

    // The reconciliation the panel exists to support: the parts must add up to
    // the whole. A gap means a record on no team or an unmapped team, which is
    // worth seeing rather than silently absorbing.
    const parts = jsPanel.meters.filter((m) => !m.is_total);
    const total = jsPanel.meters.find((m) => m.is_total);
    if (total) {
      const sumActual = parts.reduce((a, m) => a + m.actual, 0);
      const sumTarget = parts.reduce((a, m) => a + m.target, 0);
      const gap = total.actual - sumActual;
      console.log(`    reconcile: divisions sum ${sumActual.toFixed(2)} vs TOTAL ${total.actual.toFixed(2)}`
        + (Math.abs(gap) < 0.01 ? '  (exact)' : `  UNATTRIBUTED ${gap.toFixed(2)} — a record with no team or an unmapped team`));
      if (Math.abs(sumTarget - total.target) > 0.01) {
        console.log(`    WARNING: division targets sum to ${sumTarget.toFixed(2)} but the company daily target is ${total.target.toFixed(2)} — someone edited one without the others in Odoo`);
      }
    }
    console.log(`[${jsPanel.id}] meters match: ${ok}`);
    allOk = ok && allOk;
  } else if (jsPanel.type === 'table') {
    let tableOk = jsPanel.rows.length === pyPanel.rows.length;
    for (let i = 0; i < jsPanel.rows.length; i++) {
      const jr = jsPanel.rows[i], pr = pyPanel.rows[i];
      const rowOk = jr.stage === pr.stage
        && closeEnough(jr.total_opps, pr.total_opps)
        && closeEnough(jr.total_value, pr.total_value)
        && closeEnough(jr.weighted_value, pr.weighted_value);
      if (!rowOk) {
        console.log(`  [${jsPanel.id}] row ${i} MISMATCH: js=${JSON.stringify(jr)} py=${JSON.stringify(pr)}`);
        tableOk = false;
      }
    }
    console.log(`[${jsPanel.id}] table rows match: ${tableOk}`);
    allOk = tableOk && allOk;
  }
}
return allOk;
}

allOk = compareMultiDashboard('sales_dashboard', jsSalesDashboard, pySalesDashboard) && allOk;
allOk = compareMultiDashboard('division_meters', jsDivisionMeters, pyDivisionMeters) && allOk;

console.log(`\n=== OVERALL: ${allOk ? 'MATCH' : 'MISMATCH — DO NOT SHIP'} ===`);
process.exit(allOk ? 0 : 1);
