import { OdooClient } from './odooClient.js';
import { buildSalesGraphPayload } from './buildSalesGraph.js';
import { buildMultiDashboardPayload } from './buildMultiDashboard.js';
import { SALES_GRAPH_CONFIG, SALES_DASHBOARD_CONFIG } from './configs.js';

export function clientFromEnv(env) {
  return new OdooClient({
    url: env.ODOO_URL,
    db: env.ODOO_DB,
    username: env.ODOO_USERNAME,
    password: env.ODOO_PASSWORD,
  });
}

/**
 * Build one dashboard's payload on demand, for the Pages Function serving it.
 *
 * Only builds the dashboard actually requested. The cron Worker this replaced
 * built both on every run, which was wasted work — and wasted CPU, the thing
 * that kept getting it killed on Cloudflare's free tier.
 *
 * `now` is injectable so tests can pin the date; production passes nothing and
 * gets UTC, which is what the pipeline has always assumed.
 */
export async function buildDashboardPayload(env, name, now = new Date()) {
  const client = clientFromEnv(env);
  if (name === 'sales_graph') {
    return buildSalesGraphPayload(client, SALES_GRAPH_CONFIG, now);
  }
  if (name === 'sales_dashboard') {
    return buildMultiDashboardPayload(client, SALES_DASHBOARD_CONFIG, now);
  }
  throw new Error(`unknown dashboard '${name}'`);
}
