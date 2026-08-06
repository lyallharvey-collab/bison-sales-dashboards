/**
 * Refund-sign regression test.
 *
 * Credit notes carry a POSITIVE amount_untaxed in Odoo, so summing
 * out_invoice + out_refund inflates the figure by twice the refund. The
 * original Dashboard Ninja SQL got this right:
 *   case when move_type = 'out_invoice' then amount_untaxed else 0-amount_untaxed end
 * and our implementation did not — found by exporting the Ninja graph and
 * comparing, not by any test we had.
 *
 * Exercises the real code path with a fake client, so no credentials needed.
 */
import assert from 'node:assert';
import { salesOrdersComponent, ordersYtdMonthlyComponent } from './specialSources.js';
import { toUTCDate } from './dates.js';

// Minimal fake: answers the three calls the component makes, and lets us assert
// on what was asked for.
function fakeClient({ subscriptionGroups, monthlyGroups }) {
  const calls = [];
  return {
    calls,
    async searchRead(model) {
      calls.push({ model, kind: 'searchRead' });
      return [{ name: 'SUB001' }];  // one subscription order
    },
    async readGroup(model, domain, fields, groupby) {
      calls.push({ model, groupby: groupby.join(','), fields: fields.join(',') });
      if (model === 'sale.order') return [];               // no orders/proformas
      if (model === 'account.move') {
        return groupby.includes('invoice_date:month') ? monthlyGroups : subscriptionGroups;
      }
      return [];
    },
  };
}

const AUG_1 = toUTCDate(2026, 7, 1);
const AUG_31 = toUTCDate(2026, 7, 31);
const AUG_6 = toUTCDate(2026, 7, 6);

// --- daily lump: invoices minus refunds --------------------------------------
{
  // £10,000 invoiced, £1,500 credited. Correct net = £8,500.
  // The old bug summed them to £11,500 — out by 2x the refund.
  const client = fakeClient({
    subscriptionGroups: [
      { move_type: 'out_invoice', amount_untaxed: 10000 },
      { move_type: 'out_refund', amount_untaxed: 1500 },
    ],
    monthlyGroups: [],
  });
  const series = await salesOrdersComponent(client, AUG_1, AUG_31, AUG_6);
  const total = [...series.values()].reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 8500, `expected net 8500, got ${total}`);
  assert.notStrictEqual(total, 11500, 'must not be the old summed figure');

  // And it must be ONE grouped call, not a call per move_type — CPU budget.
  const moveCalls = client.calls.filter((c) => c.model === 'account.move');
  assert.strictEqual(moveCalls.length, 1, 'one account.move call');
  assert.strictEqual(moveCalls[0].groupby, 'move_type');
  console.log('daily lump nets refunds, single call: ok');
}

// --- refund larger than invoices can legitimately go negative ----------------
{
  const client = fakeClient({
    subscriptionGroups: [
      { move_type: 'out_invoice', amount_untaxed: 500 },
      { move_type: 'out_refund', amount_untaxed: 2000 },
    ],
    monthlyGroups: [],
  });
  const series = await salesOrdersComponent(client, AUG_1, AUG_31, AUG_6);
  const total = [...series.values()].reduce((a, b) => a + b, 0);
  assert.strictEqual(total, -1500, 'a net credit month is negative, not positive');
  console.log('net-credit month goes negative: ok');
}

// --- monthly (YTD) series nets per month ------------------------------------
{
  const client = fakeClient({
    subscriptionGroups: [],
    monthlyGroups: [
      { move_type: 'out_invoice', amount_untaxed: 9000, __range: { 'invoice_date:month': { from: '2026-07-01' } } },
      { move_type: 'out_refund', amount_untaxed: 1000, __range: { 'invoice_date:month': { from: '2026-07-01' } } },
      { move_type: 'out_invoice', amount_untaxed: 4000, __range: { 'invoice_date:month': { from: '2026-08-01' } } },
    ],
  });
  const series = await ordersYtdMonthlyComponent(client, toUTCDate(2026, 0, 1), toUTCDate(2026, 11, 31), AUG_6);
  assert.strictEqual(series.get('2026-07-01'), 8000, 'July nets to 9000-1000');
  assert.strictEqual(series.get('2026-08-01'), 4000, 'August has no refunds');

  const moveCalls = client.calls.filter((c) => c.model === 'account.move');
  assert.strictEqual(moveCalls.length, 1, 'one account.move call for the whole year');
  assert.strictEqual(moveCalls[0].groupby, 'invoice_date:month,move_type');
  console.log('monthly series nets per month, single call: ok');
}

// --- a month with no subscription activity at all ---------------------------
{
  const client = fakeClient({ subscriptionGroups: [], monthlyGroups: [] });
  const series = await salesOrdersComponent(client, AUG_1, AUG_31, AUG_6);
  assert.strictEqual([...series.values()].reduce((a, b) => a + b, 0), 0);
  console.log('no subscription activity: ok');
}

console.log('ALL REFUND-SIGN TESTS PASSED');
