import { isoDate } from './dates.js';
import { readGroupDaily, readGroupMonthly, readGroupTotal, addMaps } from './dataSources.js';

const PROFORMA_STAGE_ID = 2; // sale.order "Machinery Stage" = PROFORMA

async function subscriptionOrderNames(client) {
  const rows = await client.searchRead('sale.order', [['is_subscription', '=', true]], { fields: ['name'], limit: 10000 });
  return rows.map((r) => r.name);
}

async function subscriptionInvoiceTotal(client, monthStart, monthEnd) {
  const names = await subscriptionOrderNames(client);
  if (!names.length) return 0;
  return readGroupTotal(
    client, 'account.move',
    [
      ['invoice_origin', 'in', names],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted'],
      ['invoice_date', '>=', isoDate(monthStart)],
      ['invoice_date', '<=', isoDate(monthEnd)],
    ],
    'amount_untaxed',
  );
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
    const subMonthly = await readGroupMonthly(
      client, 'account.move',
      [
        ['invoice_origin', 'in', names],
        ['move_type', 'in', ['out_invoice', 'out_refund']],
        ['state', '=', 'posted'],
      ],
      'invoice_date', 'amount_untaxed', yearStart, monthTo,
    );
    combined = addMaps(combined, subMonthly);
  }
  return combined;
}

export const COMPOSITE_SOURCES = {
  sales_orders_component: salesOrdersComponent,
  orders_ytd_monthly_component: ordersYtdMonthlyComponent,
};
