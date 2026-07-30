import { OdooClient } from './odooClient.js';
import { buildSalesGraphPayload } from './buildSalesGraph.js';
import { buildMultiDashboardPayload } from './buildMultiDashboard.js';
import { SALES_GRAPH_CONFIG, SALES_DASHBOARD_CONFIG } from './configs.js';

export async function refreshAll(env) {
  const client = new OdooClient({
    url: env.ODOO_URL, db: env.ODOO_DB, username: env.ODOO_USERNAME, password: env.ODOO_PASSWORD,
  });
  const today = new Date(); // Workers run UTC; matches the previous GitHub Actions (also UTC) behaviour.

  const [salesGraph, salesDashboard] = await Promise.all([
    buildSalesGraphPayload(client, SALES_GRAPH_CONFIG, today),
    buildMultiDashboardPayload(client, SALES_DASHBOARD_CONFIG, today),
  ]);

  // One combined write, not two: Workers KV's free tier caps writes at
  // 1,000/day. At */2 cron (720 firings/day), two separate keys would be
  // 1,440 writes/day — over the cap, causing writes to silently fail once
  // the daily quota is exhausted until it resets. One key keeps it at
  // 720/day, comfortably under the limit.
  await env.DASHBOARD_DATA.put('dashboards', JSON.stringify({ sales_graph: salesGraph, sales_dashboard: salesDashboard }));

  return { salesGraph, salesDashboard };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshAll(env)
        .then(() => console.log('refreshAll: ok'))
        .catch((e) => console.error('refreshAll FAILED:', e && e.stack ? e.stack : e)),
    );
  },
  // Deliberately no public HTTP surface: this Worker only runs on its Cron
  // Trigger, so there's no remotely-triggerable route that touches Odoo
  // credentials or forces an unscheduled pull.
  async fetch() {
    return new Response('Not found', { status: 404 });
  },
};
