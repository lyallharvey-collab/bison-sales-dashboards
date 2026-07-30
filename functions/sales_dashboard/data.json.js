// See functions/sales_graph/data.json.js for the design note — same idea,
// reading the 'sales_dashboard' portion of the combined KV entry.
export async function onRequestGet({ env }) {
  const raw = await env.DASHBOARD_DATA.get('dashboards');
  if (!raw) {
    return new Response(JSON.stringify({ error: 'no data yet' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const all = JSON.parse(raw);
  return new Response(JSON.stringify(all.sales_dashboard), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
