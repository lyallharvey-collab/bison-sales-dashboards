import { readFileSync } from 'node:fs';
import { OdooClient } from './odooClient.js';
import { buildSalesGraphPayload } from './buildSalesGraph.js';
import { buildMultiDashboardPayload } from './buildMultiDashboard.js';
import { SALES_GRAPH_CONFIG, SALES_DASHBOARD_CONFIG } from './configs.js';

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

const pySalesGraph = JSON.parse(readFileSync(new URL('../output/sales_graph/data.json', import.meta.url), 'utf8'));
const pySalesDashboard = JSON.parse(readFileSync(new URL('../output/sales_dashboard/data.json', import.meta.url), 'utf8'));

function closeEnough(a, b, tol = 0.01) {
  if (a === null && b === null) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return a === b;
  return Math.abs(a - b) < tol;
}

function compareSeriesArray(label, jsSeries, pySeries) {
  let ok = true;
  if (jsSeries.length !== pySeries.length) {
    console.log(`  [${label}] series count mismatch: js=${jsSeries.length} py=${pySeries.length}`);
    return false;
  }
  for (let i = 0; i < jsSeries.length; i++) {
    const js = jsSeries[i], py = pySeries[i];
    if (js.key !== py.key) { console.log(`  [${label}] series[${i}] key mismatch`); ok = false; continue; }
    if (js.data.length !== py.data.length) {
      console.log(`  [${label}] ${js.key}: data length mismatch js=${js.data.length} py=${py.data.length}`);
      ok = false; continue;
    }
    for (let j = 0; j < js.data.length; j++) {
      if (!closeEnough(js.data[j], py.data[j])) {
        console.log(`  [${label}] ${js.key}[${j}]: js=${js.data[j]} py=${py.data[j]} MISMATCH`);
        ok = false;
      }
    }
    console.log(`  [${label}] ${js.key}: ${js.data.length} points, matches: ${ok}`);
  }
  return ok;
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

console.log('\n=== sales_dashboard ===');
for (const jsPanel of jsSalesDashboard.panels) {
  const pyPanel = pySalesDashboard.panels.find((p) => p.id === jsPanel.id);
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

console.log(`\n=== OVERALL: ${allOk ? 'MATCH' : 'MISMATCH — DO NOT SHIP'} ===`);
process.exit(allOk ? 0 : 1);
