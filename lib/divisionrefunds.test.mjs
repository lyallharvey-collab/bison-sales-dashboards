/**
 * Refund-sign regression test for the PER-DIVISION split.
 *
 * Second occurrence of the same bug. The company Orders line started netting
 * credit notes in Aug 2026, but lib/divisionSources.js was written afterwards
 * and summed `amount_untaxed` per team via a plain read_group, so the division
 * board added refunds back. A single £417.00 credit note made the divisions
 * over-read by £834.00 and stop summing to the company line — which is exactly
 * how it was found, and is the property this test pins.
 *
 * Drives the real code path with a fake client, so no credentials needed.
 */
import assert from 'node:assert';
import { divisionMeters } from './divisionSources.js';
import { toUTCDate } from './dates.js';

const AUG_12 = toUTCDate(2026, 7, 12); // a Wednesday

const TEAM = { machinery: 5, consumables: 7, sas: 6 };

/**
 * @param contractGroups read_group rows for account.move (the contract invoicing)
 * @param orderGroups    read_group rows for sale.order, keyed by team
 */
function fakeClient({ contractGroups = [], orderGroups = [] } = {}) {
  const seen = [];
  return {
    seen,
    async searchRead(model) {
      // the contract-order name lookup
      return model === 'sale.order' ? [{ name: 'SUB001' }] : [];
    },
    async readGroup(model, domain, fields, groupby) {
      seen.push({ model, groupby: groupby.join(',') });
      if (model === 'x_daily_sales_targets') {
        return [{
          x_studio_machinery_daily_target: 30400,
          x_studio_consumables_daily_target: 7200,
          x_studio_sas_daily_target: 4800,
          x_studio_company_daily_target: 42400,
        }];
      }
      if (model === 'sale.order') return orderGroups;
      if (model === 'account.move') return contractGroups;
      return [];
    },
  };
}

const actualOf = (rows, key) => rows.find((r) => r.key === key).actual;

// --- the bug: a credit note must be SUBTRACTED, per team --------------------
{
  const client = fakeClient({
    orderGroups: [{ team_id: [TEAM.sas, 'SAS'], amount_untaxed: 1000 }],
    contractGroups: [
      { team_id: [TEAM.sas, 'SAS'], move_type: 'out_invoice', amount_untaxed: 5000 },
      { team_id: [TEAM.sas, 'SAS'], move_type: 'out_refund', amount_untaxed: 417 },
    ],
  });
  const { meters } = await divisionMeters(client, { period: 'day', measure: 'orders' }, AUG_12);
  // orders leg 1000 (counted for BOTH confirmed and proforma by this fake, so
  // 2000) + contracts netted 5000-417=4583.
  const sas = actualOf(meters, 'sas');
  assert.strictEqual(sas, 2000 + 4583, `SAS should net the credit note, got ${sas}`);
  assert.notStrictEqual(sas, 2000 + 5417, 'refund was ADDED — the old bug is back');
  console.log('per-division credit note is subtracted: ok');
}

// --- and the property that caught it: parts must sum to TOTAL ---------------
{
  const client = fakeClient({
    orderGroups: [
      { team_id: [TEAM.machinery, 'MACHINERY'], amount_untaxed: 20000 },
      { team_id: [TEAM.consumables, 'CONSUMABLES'], amount_untaxed: 3000 },
    ],
    contractGroups: [
      { team_id: [TEAM.sas, 'SAS'], move_type: 'out_invoice', amount_untaxed: 5000 },
      { team_id: [TEAM.sas, 'SAS'], move_type: 'out_refund', amount_untaxed: 417 },
      { team_id: [TEAM.consumables, 'CONSUMABLES'], move_type: 'out_refund', amount_untaxed: 100 },
    ],
  });
  const { meters } = await divisionMeters(client, { period: 'day', measure: 'orders' }, AUG_12);
  const parts = meters.filter((m) => !m.is_total).reduce((a, m) => a + m.actual, 0);
  const total = meters.find((m) => m.is_total).actual;
  assert.ok(Math.abs(parts - total) < 0.005, `parts ${parts} must sum to TOTAL ${total}`);
  console.log('divisions still sum to TOTAL with refunds present: ok');
}

// --- a net-credit division goes negative rather than positive ---------------
{
  const client = fakeClient({
    contractGroups: [
      { team_id: [TEAM.sas, 'SAS'], move_type: 'out_invoice', amount_untaxed: 200 },
      { team_id: [TEAM.sas, 'SAS'], move_type: 'out_refund', amount_untaxed: 900 },
    ],
  });
  const { meters } = await divisionMeters(client, { period: 'day', measure: 'orders' }, AUG_12);
  assert.strictEqual(actualOf(meters, 'sas'), -700, 'a net-credit month must go negative');
  assert.ok(meters.find((m) => m.key === 'sas').pct < 0, 'and its percentage with it');
  console.log('net-credit division goes negative: ok');
}

// --- the contract invoicing read must be grouped by move_type at all -------
// Without move_type in the groupby there is no way to know which rows to
// subtract, so this is the structural guard against a silent regression.
{
  const client = fakeClient({
    contractGroups: [{ team_id: [TEAM.sas, 'SAS'], move_type: 'out_invoice', amount_untaxed: 10 }],
  });
  await divisionMeters(client, { period: 'day', measure: 'orders' }, AUG_12);
  const moves = client.seen.filter((s) => s.model === 'account.move');
  assert.ok(moves.length > 0, 'expected an account.move read_group');
  for (const m of moves) {
    assert.ok(m.groupby.includes('move_type'),
      `account.move grouped by "${m.groupby}" — cannot net refunds without move_type`);
  }
  console.log('contract invoicing is grouped by move_type: ok');
}

console.log('ALL PER-DIVISION REFUND TESTS PASSED');
