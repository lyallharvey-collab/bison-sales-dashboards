import { buildDashboardPayload } from '../../lib/index.js';

// Serves GET /sales_graph/data.json by querying Odoo on demand.
//
// This is now the ONLY thing that talks to Odoo in production — there is no
// cron Worker and no KV cache in front of it. That is deliberate: the
// Worker/KV/cron arrangement this replaced had three moving parts, its own
// daily write quota, and a duplicate copy of the config, all to avoid doing
// the query at request time. Doing it at request time is simpler and the
// query volume is trivial (a screen polling every 2 minutes).
//
// It sits on the same domain as the dashboard HTML, so Cloudflare Access
// gates it with the same policy — there is no separate auth to configure and
// no unauthenticated path to this data. Verified by requesting it without a
// session and confirming the redirect to the Access login.
export async function onRequestGet({ env }) {
  try {
    const payload = await buildDashboardPayload(env, 'sales_graph');
    return new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    // Surface the reason rather than a bare 500: the page keeps showing the
    // last good data and raises its stale banner, so a readable error here is
    // the only breadcrumb for why it stopped updating.
    return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
