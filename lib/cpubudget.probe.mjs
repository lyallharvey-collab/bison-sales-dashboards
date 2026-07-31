/**
 * Where does the CPU budget go on one real dashboard request?
 *
 * Run this (`npm run cpucheck`) whenever the dashboards start going stale, or
 * before adding a panel. Cloudflare's free tier allows 10ms CPU per Pages
 * Function invocation and kills anything over it (`outcome: "exceededCpu"`),
 * which is a failure that shows up as "the screen stopped updating" rather
 * than as an obvious error — this is the tool that makes it visible.
 *
 * Splits the request into response parsing (JS work, charged as CPU) and
 * network wait (I/O, not charged). Node's V8 is not Workers' V8, so read the
 * proportions rather than the absolute milliseconds.
 */
import { readFileSync } from 'node:fs';
import { OdooClient } from './odooClient.js';
import { buildJsonRpcBody, parseJsonRpcResponse } from './jsonrpc.js';
import { buildMultiDashboardPayload } from './buildMultiDashboard.js';
import { buildSalesGraphPayload } from './buildSalesGraph.js';
import { SALES_DASHBOARD_CONFIG, SALES_GRAPH_CONFIG } from './configs.js';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const BUDGET_MS = 10; // Cloudflare Workers/Pages free tier, per invocation.

class TimedClient extends OdooClient {
  constructor(opts) {
    super(opts);
    this.stats = { parseMs: 0, bytes: 0, calls: 0, perCall: [] };
  }

  async _post(service, method, args) {
    const res = await fetch(`${this.url}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildJsonRpcBody(service, method, args),
    });
    const text = await res.text();
    this.stats.bytes += Buffer.byteLength(text);
    this.stats.calls += 1;
    const t0 = process.hrtime.bigint();
    const out = parseJsonRpcResponse(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    this.stats.parseMs += ms;
    this.stats.perCall.push({
      what: `${args[3] || service}.${args[4] || method}`,
      kb: Buffer.byteLength(text) / 1024,
      ms,
      n: Array.isArray(out) ? out.length : 1,
    });
    return out;
  }
}

async function measure(label, build, cfg) {
  const client = new TimedClient({
    url: env.ODOO_URL, db: env.ODOO_DB, username: env.ODOO_USERNAME, password: env.ODOO_PASSWORD,
  });
  const t0 = process.hrtime.bigint();
  const payload = await build(client, cfg, new Date());
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const t1 = process.hrtime.bigint();
  const out = JSON.stringify(payload);
  const stringifyMs = Number(process.hrtime.bigint() - t1) / 1e6;

  const { parseMs, bytes, calls, perCall } = client.stats;
  const cpuish = parseMs + stringifyMs;

  console.log(`\n=== ${label} ===`);
  console.log(`  odoo calls        ${calls}`);
  console.log(`  received          ${(bytes / 1024).toFixed(1)} KB JSON`);
  console.log(`  wall clock        ${wallMs.toFixed(0)} ms  (network I/O — not charged as CPU)`);
  console.log(`  parsing           ${parseMs.toFixed(3)} ms  <-- charged as CPU`);
  console.log(`  stringify output  ${stringifyMs.toFixed(3)} ms`);
  console.log(`  CPU-ish total     ${cpuish.toFixed(3)} ms of the ${BUDGET_MS} ms budget  (${((cpuish / BUDGET_MS) * 100).toFixed(1)}%)`);

  const top = perCall.sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log('  heaviest calls:');
  for (const c of top) {
    console.log(`    ${c.ms.toFixed(3).padStart(7)}ms  ${c.kb.toFixed(1).padStart(6)}KB  n=${String(c.n).padStart(4)}  ${c.what}`);
  }

  const dupes = perCall.reduce((m, c) => (m[c.what] = (m[c.what] || 0) + 1, m), {});
  const repeated = Object.entries(dupes).filter(([, n]) => n > 1);
  console.log(repeated.length
    ? `  repeated calls: ${repeated.map(([w, n]) => `${n}x ${w}`).join(', ')}`
    : '  repeated calls: none (client dedup working)');

  return cpuish;
}

const a = await measure('sales_graph', buildSalesGraphPayload, SALES_GRAPH_CONFIG);
const b = await measure('sales_dashboard', buildMultiDashboardPayload, SALES_DASHBOARD_CONFIG);

const worst = Math.max(a, b);
console.log(`\nworst case ${worst.toFixed(3)} ms vs ${BUDGET_MS} ms budget — headroom ~${(BUDGET_MS / worst).toFixed(0)}x`);
if (worst > BUDGET_MS * 0.5) {
  console.log('WARNING: over half the budget. Consider the $5/month Workers Standard plan (30s CPU).');
}
