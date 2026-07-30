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

  await Promise.all([
    env.DASHBOARD_DATA.put('sales_graph', JSON.stringify(salesGraph)),
    env.DASHBOARD_DATA.put('sales_dashboard', JSON.stringify(salesDashboard)),
  ]);

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
