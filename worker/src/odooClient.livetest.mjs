import { readFileSync } from 'node:fs';
import { OdooClient } from './odooClient.js';

// Load ../../.env manually (no dotenv dependency in the worker package).
const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const env = {};
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const client = new OdooClient({
  url: env.ODOO_URL, db: env.ODOO_DB, username: env.ODOO_USERNAME, password: env.ODOO_PASSWORD,
});

const uid = await client.uid();
console.log('authenticated, uid =', uid);

const me = await client.execute('res.users', 'read', [[uid]], { fields: ['name', 'login'] });
console.log('read:', JSON.stringify(me));

const targets = await client.searchRead('x_daily_sales_targets', [], { fields: ['x_studio_date', 'x_studio_company_daily_target'], limit: 3 });
console.log('search_read sample:', JSON.stringify(targets));

const groups = await client.readGroup(
  'x_daily_sales_targets',
  [['x_studio_date', '>=', '2026-07-01'], ['x_studio_date', '<=', '2026-07-31']],
  ['x_studio_company_daily_target'],
  ['x_studio_date:day'],
  false,
);
console.log('read_group groups:', groups.length);
console.log('first group:', JSON.stringify(groups[0]));
console.log('has __range:', !!(groups[0] && groups[0].__range));

const count = await client.searchCount('crm.lead', [['active', 'in', [true, false]]]);
console.log('crm.lead search_count (all, incl archived):', count);

console.log('LIVE ODOO CLIENT TEST PASSED');
