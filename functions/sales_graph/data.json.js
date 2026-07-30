// Cloudflare Pages Function — intercepts /sales_graph/data.json and serves
// the live payload from KV (written every 2 minutes by the
// bison-dashboard-refresher Worker) instead of a static build-time file.
// Lives on the same domain/zone as the rest of the Pages project, so it
// inherits the same Cloudflare Access policy already gating the dashboard —
// no separate auth to configure, and nothing new to accidentally leave open.
//
// Both dashboards' payloads live under one KV key ("dashboards") rather than
// one key each — Workers KV's free tier caps writes at 1,000/day, and two
// keys at a 2-minute cron would be 1,440/day, over the cap.
export async function onRequestGet({ env }) {
  const raw = await env.DASHBOARD_DATA.get('dashboards');
  if (!raw) {
    return new Response(JSON.stringify({ error: 'no data yet' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  const all = JSON.parse(raw);
  return new Response(JSON.stringify(all.sales_graph), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
