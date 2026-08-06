/**
 * Weekend-folding regression tests.
 *
 * The month-start case here is a real data-loss bug that shipped: weekend
 * activity on the 1st/2nd of a month rolled back into the PREVIOUS month,
 * which isn't on the chart's axis, so the money silently disappeared. August
 * 2026 opens on a Saturday and the service-contract invoices are dated the
 * 1st, so this was live, not theoretical.
 */
import assert from 'node:assert';
import { foldWeekendsIntoPriorBusinessDay, cumulativeOverBuckets } from './dataSources.js';
import { toUTCDate, isoDate, businessDaysInRange } from './dates.js';

const AUG_1 = toUTCDate(2026, 7, 1);  // Saturday
const AUG_6 = toUTCDate(2026, 7, 6);  // Thursday

// 1. Mid-month weekend still folds BACKWARD to the same week's Friday, so it
//    shows up immediately rather than waiting for Monday.
{
  // Sat 8 Aug + Sun 9 Aug -> Fri 7 Aug
  const folded = foldWeekendsIntoPriorBusinessDay(
    new Map([['2026-08-08', 100], ['2026-08-09', 50], ['2026-08-07', 10]]), AUG_1);
  assert.strictEqual(folded.get('2026-08-07'), 160);
  assert.strictEqual(folded.size, 1);
  console.log('mid-month weekend folds backward: ok');
}

// 2. THE BUG: a weekend at the start of the month must roll FORWARD, because
//    rolling back would leave the month and drop the value.
{
  const folded = foldWeekendsIntoPriorBusinessDay(
    new Map([['2026-08-01', 5000], ['2026-08-02', 250], ['2026-08-03', 1000]]), AUG_1);
  assert.strictEqual(folded.get('2026-08-03'), 6250, 'Sat+Sun+Mon all land on Monday the 3rd');
  assert.ok(!folded.has('2026-07-31'), 'nothing escapes into July');

  // And end-to-end: the charted cumulative must equal the money that went in.
  const buckets = businessDaysInRange(AUG_1, AUG_6);
  const cum = cumulativeOverBuckets(folded, buckets);
  const charted = [...cum.values()].pop();
  assert.strictEqual(charted, 6250, 'no loss between input and chart');
  console.log('month-start weekend rolls forward, nothing lost: ok');
}

// 3. Without a floor the old behaviour is preserved (backward always), so the
//    argument is genuinely opt-in and can't surprise another caller.
{
  const folded = foldWeekendsIntoPriorBusinessDay(new Map([['2026-08-01', 5000]]));
  assert.strictEqual(isoDate(new Date([...folded.keys()][0] + 'T00:00:00Z')), '2026-07-31');
  console.log('no floor -> unchanged backward behaviour: ok');
}

// 4. A month that opens on a weekday is untouched by any of this.
{
  const JUL_1 = toUTCDate(2026, 6, 1); // Wednesday
  const folded = foldWeekendsIntoPriorBusinessDay(
    new Map([['2026-07-04', 300], ['2026-07-01', 20]]), JUL_1); // Sat 4 Jul -> Fri 3 Jul
  assert.strictEqual(folded.get('2026-07-03'), 300);
  assert.strictEqual(folded.get('2026-07-01'), 20);
  console.log('month opening on a weekday: ok');
}

// 5. Totals are conserved for a whole month of daily values — the property that
//    actually matters. Folding may move money between days but must never
//    create or destroy any.
{
  const daily = new Map();
  let expected = 0;
  for (let day = 1; day <= 6; day++) {
    const iso = `2026-08-0${day}`;
    daily.set(iso, day * 100);
    expected += day * 100;
  }
  const folded = foldWeekendsIntoPriorBusinessDay(daily, AUG_1);
  const total = [...folded.values()].reduce((a, b) => a + b, 0);
  assert.strictEqual(total, expected, 'folding conserves the total');
  const cum = cumulativeOverBuckets(folded, businessDaysInRange(AUG_1, AUG_6));
  assert.strictEqual([...cum.values()].pop(), expected, 'and so does the chart');
  console.log('totals conserved across the month: ok');
}

console.log('ALL WEEKEND FOLDING TESTS PASSED');
