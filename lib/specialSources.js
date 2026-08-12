import { isoDate } from './dates.js';
import { readGroupDaily, readGroupMonthly, readGroupTotal, addMaps } from './dataSources.js';

// Exported because divisionSources.js builds the SAME "Orders" measure split by
// team, and the two definitions drifting apart would be invisible on screen.
export const PROFORMA_STAGE_ID = 2; // sale.order "Machinery Stage" = PROFORMA

/**
 * The service-contract plans that count toward the sales target.
 *
 * 1 = "Upgraded Service Contract" (monthly), 2 = "Upgraded Annual Contract".
 * These are the only two sale.subscription.plan records that exist, so today
 * this is equivalent to "has a plan" — but it is written as an explicit list
 * because the reference SQL says `plan_id in (1,2)`, and a THIRD plan added in
 * Odoo would be silently excluded by both. `npm run sqlcheck` fails if a plan
 * outside this list appears, so that drift is loud rather than silent.
 */
export const CONTRACT_PLAN_IDS = [1, 2];

/** A sale order that IS a contract on one of those plans, or a child order of
 * one (a renewal keeps `subscription_id` pointing at its parent). Mirrors the
 * SQL's `so.plan_id in (1,2) OR EXISTS (parent pp WHERE pp.plan_id in (1,2))`. */
const CONTRACT_ORDER_DOMAIN = ['|',
  ['plan_id', 'in', CONTRACT_PLAN_IDS],
  ['subscription_id.plan_id', 'in', CONTRACT_PLAN_IDS]];

/** Excludes contract orders and children of them from the confirmed-orders leg,
 * so a contract is not counted twice — see salesOrdersComponent. Exported
 * because divisionSources.js has to apply the SAME exclusion, or the division
 * board and the company line would disagree about what an order is. */
export const NOT_A_CONTRACT_ORDER = [['plan_id', '=', false], ['subscription_id', '=', false]];

export async function subscriptionOrderNames(client) {
  const rows = await client.searchRead('sale.order', CONTRACT_ORDER_DOMAIN, { fields: ['name'], limit: 10000 });
  return rows.map((r) => r.name);
}

/**
 * Domain for service-contract invoicing in a window.
 *
 * WHICH CONTRACTS COUNT — settled Aug 2026 against the corrected SQL. Contract
 * invoices are found by matching `invoice_origin` against the names of orders on
 * a contract plan (or children of one). The SQL instead walks the line-level
 * relation account_move_line -> sale_order_line_invoice_rel -> sale_order_line
 * -> sale_order. In the current month the two select an identical set, but over
 * 2026 the relation misses 20 invoices worth a net £5,800.64 which have no row
 * in sale_order_line_invoice_rel at all — e.g. invoice 187375, origin 188656,
 * whose order IS on a plan and whose only line has sale_line_ids = []. Matching
 * on the origin keeps that money, so it stays. `npm run sqlcheck` reports the
 * difference every run and FAILS if it ever inverts (i.e. if the relation starts
 * finding contract invoices this misses, which a blank or comma-joined
 * invoice_origin would cause).
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
 * day with activity, before the running total is taken.
 *
 * Contract orders are EXCLUDED from the confirmed-orders leg. They would
 * otherwise be counted twice — once when the contract is confirmed and again
 * when it invoices — which was worth £6,215.30 in August 2026 alone. Note the
 * proforma leg is deliberately NOT filtered the same way: the reference SQL
 * applies the exclusion only to confirmed orders. */
export async function salesOrdersComponent(client, monthStart, monthEnd, today) {
  const dayTo = today; // month bounds are always derived from today, so today <= monthEnd always
  const confirmed = await readGroupDaily(client, 'sale.order', [['state', '=', 'sale'], ...NOT_A_CONTRACT_ORDER], 'date_order', 'amount_untaxed', monthStart, dayTo);
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
  // Contract orders excluded here too — same double-count, see salesOrdersComponent.
  const confirmed = await readGroupMonthly(client, 'sale.order', [['state', '=', 'sale'], ...NOT_A_CONTRACT_ORDER], 'date_order', 'amount_untaxed', yearStart, monthTo);
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
