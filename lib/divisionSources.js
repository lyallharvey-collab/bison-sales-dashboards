/**
 * Per-division actual-vs-target scalars — the data behind the "thermometer"
 * meter panel. Brings back the WIG scoreboard Bison ran in Excel until 2023.
 *
 * Why it exists: the company total hides the story. The 2023 sheet's overall
 * "72% of target" was Machinery 72%, Consumables 7%, SAS 231% — three
 * completely different situations averaging into one unremarkable number.
 * The disaggregation IS the feature.
 *
 * Mirrored in dashboards/division_sources.py; `npm run livetest` diffs the two.
 */

import { isoDate, monthBounds, rollBackToBusinessDay } from './dates.js';
import { addMaps, readGroupByTeam, readGroupNetByTeam, readGroupTotals } from './dataSources.js';
import { NOT_A_CONTRACT_ORDER, PROFORMA_STAGE_ID, subscriptionOrderNames } from './specialSources.js';

/**
 * The whole business, in three parts. Verified against live Odoo: there are
 * exactly three crm.team records, so this is a closed 1:1 mapping.
 *
 * The other x_studio_*_daily_target columns on x_daily_sales_targets (ARB, BC,
 * CC, GBH, PCD, RHB, SRH, Grange) are PER-SALESPERSON, not divisions — and
 * their labels disagree with their field names (x_studio_cc_daily_target is
 * labelled "CJB", x_studio_gbh_daily_target is "LMJ"), i.e. initials. Ignore
 * them here.
 */
export const DIVISIONS = [
  { key: 'machinery', label: 'Machinery', teamId: 5, targetField: 'x_studio_machinery_daily_target' },
  { key: 'consumables', label: 'Consumables', teamId: 7, targetField: 'x_studio_consumables_daily_target' },
  { key: 'sas', label: 'SAS', teamId: 6, targetField: 'x_studio_sas_daily_target' },
];

/** TOTAL's target comes from the company field, NOT the sum of the three, so
 * this page and the Sales Graph can never disagree about what the company
 * target is. They do agree in Odoo today (30,400 + 7,200 + 4,800 = 42,400);
 * if someone ever edits one without the others, TOTAL will visibly stop
 * matching the tubes, which is the honest outcome. */
const COMPANY_TARGET_FIELD = 'x_studio_company_daily_target';

export const MEASURES = {
  // Colour follows the entity: the same blue/green these measures wear as
  // lines on the Sales Graph. No new colours, so no palette revalidation.
  orders: { label: 'Orders', color: '#1e88e5' },
  invoiced: { label: 'Invoiced', color: '#43a047' },
};

export const PERIOD_LABELS = { day: 'daily target', month: 'target to date' };

/**
 * The date window the meter covers.
 *
 * `day` — today, except that a weekend rolls BACK to include the prior Friday.
 * x_daily_sales_targets has no weekend rows at all (verified: 2026-08-08/09
 * simply don't exist), so a Saturday would otherwise divide by a zero target
 * while Saturday's orders sat invisible. Rolling back is the same fold the
 * charts already apply — see foldWeekendsIntoPriorBusinessDay.
 *
 * `month` — month-to-date, compared against the month-to-date target. Never
 * against the full-month target: £4.8m against a £10.6m full-year target reads
 * as 45% when the honest figure is 77% of pace. Settled precedent here.
 */
export function meterBounds(period, today) {
  if (period === 'month') return [monthBounds(today)[0], today];
  return [rollBackToBusinessDay(today), today];
}

async function subscriptionInvoicesByTeam(client, from, to) {
  const names = await subscriptionOrderNames(client);
  if (!names.length) return new Map();
  // NET, not summed — credit notes are positive in Odoo. See readGroupNetByTeam.
  return readGroupNetByTeam(
    client, 'account.move',
    [
      ['invoice_origin', 'in', names],
      ['move_type', 'in', ['out_invoice', 'out_refund']],
      ['state', '=', 'posted'],
    ],
    'invoice_date', 'amount_untaxed', from, to,
  );
}

/**
 * The same three ingredients as the company Orders line — confirmed orders,
 * proformas, subscription invoicing — but split by team.
 *
 * Contract orders are excluded from the confirmed leg for the same reason as
 * the company line — they invoice separately and would otherwise count twice.
 * The exclusion is imported rather than restated so the two cannot drift.
 *
 * ONE deliberate divergence: salesOrdersComponent pins the whole month's
 * subscription lump onto the month's first day with activity, because the
 * original SQL joined one monthly total onto one row. A meter covering a
 * single day has no "first day of the month" to pin to, so subscription
 * invoices are counted on their real invoice_date instead. Currently ~£2.8k a
 * month, all SAS, against a £4.8k/day SAS target — small in total but material
 * on the day it lands, so dropping it would understate SAS.
 */
async function ordersByTeam(client, from, to) {
  const [confirmed, proforma, subscriptions] = await Promise.all([
    readGroupByTeam(client, 'sale.order', [['state', '=', 'sale'], ...NOT_A_CONTRACT_ORDER], 'date_order', 'amount_untaxed', from, to),
    readGroupByTeam(
      client, 'sale.order',
      [['state', 'in', ['draft', 'sent']], ['machinary_stage_id', '=', PROFORMA_STAGE_ID]],
      'date_order', 'amount_untaxed', from, to,
    ),
    subscriptionInvoicesByTeam(client, from, to),
  ]);
  return addMaps(addMaps(confirmed, proforma), subscriptions);
}

/** Same domain as the Invoiced series on the Sales Graph. */
async function invoicedByTeam(client, from, to) {
  return readGroupByTeam(
    client, 'bison_core.account_move_gp_report',
    [
      ['move_id.state', '=', 'posted'],
      ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
    ],
    'sales_target_date', 'aml_total_net', from, to,
  );
}

/**
 * Pure assembly of the meter rows — separated out so it can be unit-tested
 * without Odoo (lib/meters.test.mjs).
 *
 * `pct` is null, never 0 or Infinity, when the target is zero: "no target set"
 * and "0% of target" are different statements and the renderer treats them
 * differently.
 */
export function assembleMeters(targets, actualsByTeam) {
  const rows = DIVISIONS.map((d) => {
    const target = targets[d.targetField] || 0;
    const actual = actualsByTeam.get(d.teamId) || 0;
    return {
      key: d.key, label: d.label, target, actual,
      pct: target ? actual / target : null,
      is_total: false,
    };
  });

  // TOTAL sums the SOURCE, not the three rows above: a record with no team, or
  // on a fourth team someone adds in Odoo without mapping it here, still counts
  // towards the company figure. A scoreboard whose parts silently fail to add
  // up to the whole is worse than one showing an unattributed remainder.
  let actual = 0;
  for (const v of actualsByTeam.values()) actual += v;
  const target = targets[COMPANY_TARGET_FIELD] || 0;
  rows.push({
    key: 'total', label: 'TOTAL', target, actual,
    pct: target ? actual / target : null,
    is_total: true,
  });
  return rows;
}

/**
 * @param period  'day' (default) | 'month'
 * @param measure 'orders' (default) | 'invoiced'
 */
export async function divisionMeters(client, { period = 'day', measure = 'orders' } = {}, today) {
  if (!MEASURES[measure]) throw new Error(`unknown meter measure '${measure}'`);
  if (period !== 'day' && period !== 'month') throw new Error(`unknown meter period '${period}'`);
  const [from, to] = meterBounds(period, today);

  const [targets, actualsByTeam] = await Promise.all([
    // One read_group, four measures — not four read_groups. CPU budget.
    readGroupTotals(
      client, 'x_daily_sales_targets',
      [['x_studio_date', '>=', isoDate(from)], ['x_studio_date', '<=', isoDate(to)]],
      [...DIVISIONS.map((d) => d.targetField), COMPANY_TARGET_FIELD],
    ),
    measure === 'invoiced' ? invoicedByTeam(client, from, to) : ordersByTeam(client, from, to),
  ]);

  return {
    period,
    measure,
    measure_label: MEASURES[measure].label,
    period_label: PERIOD_LABELS[period],
    color: MEASURES[measure].color,
    period_from: isoDate(from),
    period_to: isoDate(to),
    meters: assembleMeters(targets, actualsByTeam),
  };
}
