// Cloudflare Pages Function — intercepts /sales_graph/data.json and serves
// the live payload from KV (written every 2 minutes by the
// bison-dashboard-refresher Worker) instead of a static build-time file.
// Lives on the same domain/zone as the rest of the Pages project, so it
// inherits the same Cloudflare Access policy already gating the dashboard —
// no separate auth to configure, and nothing new to accidentally leave open.
export async function onRequestGet({ env }) {
  const raw = await env.DASHBOARD_DATA.get('sales_graph');
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
