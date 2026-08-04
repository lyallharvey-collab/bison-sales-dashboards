import { buildDashboardPayload } from '../../lib/index.js';

// See functions/sales_graph/data.json.js for the design note — same shape,
// building the division-meter payload instead.
export async function onRequestGet({ env }) {
  try {
    const payload = await buildDashboardPayload(env, 'division_meters');
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
