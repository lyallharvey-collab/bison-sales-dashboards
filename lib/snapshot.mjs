/**
 * Print every number the live dashboards are currently showing, with
 * reconciliation checks.
 *
 * Uses the SAME code path the Pages Functions use (buildDashboardPayload), so
 * this is what the pages would serve right now — not a re-implementation.
 * Needed because Cloudflare Access returns 302 to anything unauthenticated, so
 * production cannot be inspected with curl.
 *
 * Run: node lib/snapshot.mjs
 */
import { readFileSync } from 'node:fs';
import { buildDashboardPayload } from './index.js';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const gbp = (v) => (v === null || v === undefined)
  ? '—'
  : '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (v) => (v === null || v === undefined) ? '—' : (v * 100).toFixed(2) + '%';
const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol;

const now = new Date();
console.log('snapshot at', now.toISOString(), '(UTC)\n');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- sales_graph
const sg = await buildDashboardPayload(env, 'sales_graph', now);
console.log('='.repeat(78));
console.log(`SALES GRAPH — ${sg.title}`);
console.log('='.repeat(78));
const lastIdx = (d) => { let i = -1; d.forEach((v, k) => { if (v !== null && v !== undefined) i = k; }); return i; };
const actualIdx = Math.max(...sg.series.filter((s) => !s.is_reference).map((s) => lastIdx(s.data)));
console.log(`business days in month: ${sg.labels.length}   today = day ${actualIdx + 1} (${sg.labels[actualIdx]})\n`);
console.log('  series        to-date        month-end      % of to-date target');
for (const s of sg.series) {
  const toDate = s.data[actualIdx];
  const end = s.data[lastIdx(s.data)];
  const target = sg.series.find((x) => x.key === 'target').data[actualIdx];
  const pct = (toDate !== null && target) ? toDate / target : null;
  console.log(`  ${s.label.padEnd(12)} ${gbp(toDate).padStart(14)} ${gbp(s.is_reference ? end : null).padStart(14)}  ${s.is_reference ? '' : pc(pct)}`);
}

// ------------------------------------------------------------ sales_dashboard
const sd = await buildDashboardPayload(env, 'sales_dashboard', now);
console.log('\n' + '='.repeat(78));
console.log(`SALES DASHBOARD — ${sd.title}`);
console.log('='.repeat(78));
for (const p of sd.panels) {
  if (p.type === 'line_chart') {
    const ai = Math.max(...p.series.filter((s) => !s.is_reference).map((s) => lastIdx(s.data)));
    console.log(`\n  [${p.id}]  ${p.labels.length} points, latest filled = ${p.labels[ai]}`);
    for (const s of p.series) {
      console.log(`    ${s.label.padEnd(12)} to-date ${gbp(s.data[ai]).padStart(14)}   period-end ${gbp(s.data[lastIdx(s.data)]).padStart(14)}`);
    }
  } else if (p.type === 'kpi') {
    console.log(`\n  [${p.id}]  ${p.caption} = ${p.value}`);
  } else if (p.type === 'table') {
    console.log(`\n  [${p.id}]  ${p.title}`);
    console.log('    stage                opps        total value     weighted value');
    for (const r of p.rows) {
      console.log(`    ${String(r.stage).padEnd(18)} ${String(r.total_opps).padStart(5)}  ${gbp(r.total_value).padStart(16)}  ${gbp(r.weighted_value).padStart(16)}`);
    }
    const body = p.rows.filter((r) => String(r.stage).toUpperCase() !== 'TOTAL');
    const tot = p.rows.find((r) => String(r.stage).toUpperCase() === 'TOTAL');
    if (tot) {
      const so = body.reduce((a, r) => a + r.total_opps, 0);
      const sv = body.reduce((a, r) => a + r.total_value, 0);
      const sw = body.reduce((a, r) => a + r.weighted_value, 0);
      console.log('');
      check('pipeline stage counts sum to TOTAL', so === tot.total_opps, `${so} vs ${tot.total_opps}`);
      check('pipeline values sum to TOTAL', near(sv, tot.total_value), `${gbp(sv)} vs ${gbp(tot.total_value)}`);
      check('pipeline weighted sums to TOTAL', near(sw, tot.weighted_value), `${gbp(sw)} vs ${gbp(tot.weighted_value)}`);
    }
  }
}

// ------------------------------------------------------------ division_meters
const dm = await buildDashboardPayload(env, 'division_meters', now);
console.log('\n' + '='.repeat(78));
console.log(`DIVISION METERS — ${dm.title}`);
console.log('='.repeat(78));
for (const p of dm.panels) {
  if (p.type !== 'meter_group') continue;
  console.log(`\n  [${p.id}] ${p.title}`);
  console.log(`  measure=${p.measure} (${p.measure_label})  period=${p.period} (${p.period_label})  ${p.period_from} .. ${p.period_to}\n`);
  console.log('  division            actual           target            %      recomputed');
  for (const m of p.meters) {
    // Recompute the percentage from actual/target independently, so a wrong
    // pct in the payload can't hide behind a plausible-looking number.
    const recomputed = m.target ? m.actual / m.target : null;
    const agrees = (m.pct === null || recomputed === null) ? '—' : (near(m.pct, recomputed, 0.0001) ? 'agrees' : 'MISMATCH');
    console.log(`  ${String(m.label).padEnd(14)} ${gbp(m.actual).padStart(14)}  ${gbp(m.target).padStart(14)}  ${pc(m.pct).padStart(9)}  ${agrees}`);
  }

  // The reconciliation the plan called for: the parts must equal the whole.
  const body = p.meters.filter((m) => !m.is_total);
  const tot = p.meters.find((m) => m.is_total);
  console.log('');
  if (tot) {
    const sa = body.reduce((a, m) => a + (m.actual || 0), 0);
    const st = body.reduce((a, m) => a + (m.target || 0), 0);
    check('division actuals sum to TOTAL', near(sa, tot.actual), `${gbp(sa)} vs ${gbp(tot.actual)}`);
    check('division targets sum to TOTAL', near(st, tot.target), `${gbp(st)} vs ${gbp(tot.target)}`);
    for (const m of p.meters) {
      const rc = m.target ? m.actual / m.target : null;
      if (rc !== null) check(`${m.label} pct = actual/target`, near(m.pct, rc, 0.0001), pc(m.pct));
    }
  }

  // And the cross-dashboard check: does today's division total agree with the
  // company Orders figure the main dashboard shows for the same day?
  const sgSeries = sg.series.find((s) => s.key === 'orders');
  const sgTargetSeries = sg.series.find((s) => s.key === 'target');
  if (p.measure === 'orders' && p.period === 'day') {
    const todayOrders = sgSeries.data[actualIdx] - (actualIdx > 0 ? sgSeries.data[actualIdx - 1] : 0);
    const todayTarget = sgTargetSeries.data[actualIdx] - (actualIdx > 0 ? sgTargetSeries.data[actualIdx - 1] : 0);
    const divTotal = tot ? tot.actual : body.reduce((a, m) => a + (m.actual || 0), 0);
    const divTarget = tot ? tot.target : body.reduce((a, m) => a + (m.target || 0), 0);
    console.log('  cross-check vs the Sales Graph, same day:');
    check('meters actual = Sales Graph daily Orders step', near(divTotal, todayOrders, 1),
      `${gbp(divTotal)} vs ${gbp(todayOrders)}`);
    check('meters target = Sales Graph daily Target step', near(divTarget, todayTarget, 1),
      `${gbp(divTarget)} vs ${gbp(todayTarget)}`);
  }
}

console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `${failed.length} CHECK(S) FAILED` : `all ${checks.length} reconciliation checks passed`);
process.exit(failed.length ? 1 : 0);
