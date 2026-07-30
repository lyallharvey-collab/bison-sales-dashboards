// See functions/sales_graph/data.json.js for the design note — same idea,
// reading the 'sales_dashboard' key instead.
export async function onRequestGet({ env }) {
  const raw = await env.DASHBOARD_DATA.get('sales_dashboard');
  if (!raw) {
    return new Response(JSON.stringify({ error: 'no data yet' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(raw, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
