import { isoDate } from './dates.js';
import { readGroupDaily, readGroupMonthly, readGroupTotal, addMaps } from './dataSources.js';

// Exported because divisionSources.js builds the SAME "Orders" measure split by
// team, and the two definitions drifting apart would be invisible on screen.
export const PROFORMA_STAGE_ID = 2; // sale.order "Machinery Stage" = PROFORMA

export async function subscriptionOrderNames(client) {
  const rows = await client.searchRead('sale.order', [['is_subscription', '=', true]], { fields: ['name'], limit: 10000 });
  return rows.map((r) => r.name);
}

/**
 * Domain for subscription / service-contract invoicing in a window.
 *
 * NOTE on which contracts count: this matches on `is_subscription = true`
 * sale orders. The original Dashboard Ninja SQL instead matched
 * `invoice_origin in (select code from sale_subscription)` — a table with no
 * Odoo model behind it, i.e. a pre-migration leftover that nothing maintains,
 * so contracts created since the migration can never appear in it. That makes
 * the two figures differ (observed: £24,088.18 here vs £15,506.25 there in
 * Aug 2026). Settling it is a business decision about which contracts should
 * count toward the sales target — see README.
 */
function subscriptionInvoiceDomain(names, from, to) {
  return [
    ['invoice_origin', 'in', names],
    ['move_type', 'in', ['out_invoice', 'out_refund']],
    ['state', '=', 'posted'],
    ['invoice_date', '>=', isoDate(from)],
    ['invoice_date', '<=', isoDate(to)],
  ];
}

/** Credit notes have a POSITIVE amount_untaxed in Odoo, so they have to be
 * subtracted rather than summed — the original SQL did
 * `case when move_type = 'out_invoice' then amount_untaxed else 0-amount_untaxed end`.
 * Summing both inflated Orders by twice any refund. Grouping by move_type keeps
 * this to a single call (CPU budget). */
function netInvoicesMinusRefunds(groups) {
  let net = 0;
  for (const g of groups) {
    const t = Array.isArray(g.move_type) ? g.move_type[0] : g.move_type;
    const amount = g.amount_untaxed || 0;
    net += (t === 'out_refund') ? -amount : amount;
  }
  return net;
}

async function subscriptionInvoiceTotal(client, monthStart, monthEnd) {
  const names = await subscriptionOrderNames(client);
  if (!names.length) return 0;
  const groups = await client.readGroup(
    'account.move', subscriptionInvoiceDomain(names, monthStart, monthEnd),
    ['amount_untaxed'], ['move_type'], false,
  );
  return netInvoicesMinusRefunds(groups);
}

/** Per-month net subscription invoicing, for the Year-To-Date chart. One call,
 * grouped by month AND move_type, then netted per month. */
async function subscriptionNetByMonth(client, names, from, to) {
  const groups = await client.readGroup(
    'account.move', subscriptionInvoiceDomain(names, from, to),
    ['amount_untaxed'], ['invoice_date:month', 'move_type'], false,
  );
  const out = new Map();
  for (const g of groups) {
    const rng = g.__range && g.__range['invoice_date:month'];
    if (!rng || !rng.from) continue;
    const key = String(rng.from).slice(0, 10);
    const t = Array.isArray(g.move_type) ? g.move_type[0] : g.move_type;
    const amount = g.amount_untaxed || 0;
    out.set(key, (out.get(key) || 0) + ((t === 'out_refund') ? -amount : amount));
  }
  return out;
}

/** Mirrors special_sources.py's sales_orders_component: confirmed orders +
 * proformas + a monthly subscription-invoicing lump applied to the first
 * day with activity, before the running total is taken. */
export async function salesOrdersComponent(client, monthStart, monthEnd, today) {
  const dayTo = today; // month bounds are always derived from today, so today <= monthEnd always
  const confirmed = await readGroupDaily(client, 'sale.order', [['state', '=', 'sale']], 'date_order', 'amount_untaxed', monthStart, dayTo);
  const proforma = await readGroupDaily(
    client, 'sale.order',
    [['state', 'in', ['draft', 'sent']], ['machinary_stage_id', '=', PROFORMA_STAGE_ID]],
    'date_order', 'amount_untaxed', monthStart, dayTo,
  );
  const combined = addMaps(confirmed, proforma);

  const subTotal = await subscriptionInvoiceTotal(client, monthStart, monthEnd);
  if (subTotal) {
    const keys = [...combined.keys()].sort();
    const firstDay = keys.length ? keys[0] : isoDate(monthStart);
    combined.set(firstDay, (combined.get(firstDay) || 0) + subTotal);
  }
  return combined;
}

/** Monthly analogue for the Year-To-Date chart — the subscription
 * component recurs every month here rather than being a single lump. */
export async function ordersYtdMonthlyComponent(client, yearStart, yearEnd, today) {
  const monthTo = today; // year bounds derived from today, so today <= yearEnd always
  const confirmed = await readGroupMonthly(client, 'sale.order', [['state', '=', 'sale']], 'date_order', 'amount_untaxed', yearStart, monthTo);
  const proforma = await readGroupMonthly(
    client, 'sale.order',
    [['state', 'in', ['draft', 'sent']], ['machinary_stage_id', '=', PROFORMA_STAGE_ID]],
    'date_order', 'amount_untaxed', yearStart, monthTo,
  );
  let combined = addMaps(confirmed, proforma);

  const names = await subscriptionOrderNames(client);
  if (names.length) {
    // Netted per month, not summed — see netInvoicesMinusRefunds above.
    const subMonthly = await subscriptionNetByMonth(client, names, yearStart, monthTo);
    combined = addMaps(combined, subMonthly);
  }
  return combined;
}

export const COMPOSITE_SOURCES = {
  sales_orders_component: salesOrdersComponent,
  orders_ytd_monthly_component: ordersYtdMonthlyComponent,
};
