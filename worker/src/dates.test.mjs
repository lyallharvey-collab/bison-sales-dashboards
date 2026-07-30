import assert from 'node:assert';
import { toUTCDate, isoDate, isWeekend, monthBounds, businessDaysInRange, rollBackToBusinessDay, isoWeekBounds, weekday } from './dates.js';

// 2026-07-01 is a Wednesday (confirmed against live Odoo data this session).
const wed = toUTCDate(2026, 6, 1);
assert.strictEqual(weekday(wed), 3); // Sun=0..Sat=6, Wed=3
assert.strictEqual(isWeekend(wed), false);

const sat = toUTCDate(2026, 6, 4);
const sun = toUTCDate(2026, 6, 5);
assert.strictEqual(isWeekend(sat), true);
assert.strictEqual(isWeekend(sun), true);
assert.strictEqual(isoDate(rollBackToBusinessDay(sat)), '2026-07-03'); // back to Friday
assert.strictEqual(isoDate(rollBackToBusinessDay(sun)), '2026-07-03'); // both weekend days -> same Friday
assert.strictEqual(isoDate(rollBackToBusinessDay(wed)), '2026-07-01'); // business day passes through unchanged
console.log('weekend/rollback: ok');

const [monthStart, monthEnd] = monthBounds(toUTCDate(2026, 6, 28));
assert.strictEqual(isoDate(monthStart), '2026-07-01');
assert.strictEqual(isoDate(monthEnd), '2026-07-31');
console.log('monthBounds: ok');

const bdays = businessDaysInRange(monthStart, monthEnd);
assert.strictEqual(bdays.length, 23); // matches the live read_group count from the earlier test
assert.strictEqual(isoDate(bdays[0]), '2026-07-01');
assert.strictEqual(isoDate(bdays[3]), '2026-07-06'); // skips the weekend (07-04/05)
assert.strictEqual(isoDate(bdays[bdays.length - 1]), '2026-07-31');
console.log('businessDaysInRange: ok, count =', bdays.length);

// isoWeekBounds: today=2026-07-30 is a Thursday -> week is Mon 07-27..Sun 08-02
const [monday, sunday] = isoWeekBounds(toUTCDate(2026, 6, 30));
assert.strictEqual(isoDate(monday), '2026-07-27');
assert.strictEqual(isoDate(sunday), '2026-08-02');
console.log('isoWeekBounds (midweek): ok');

// Edge case: today IS a Sunday -> monday should be 6 days earlier, not today.
const [monday2, sunday2] = isoWeekBounds(toUTCDate(2026, 7, 2)); // Aug 2, 2026 is a Sunday
assert.strictEqual(isoDate(monday2), '2026-07-27');
assert.strictEqual(isoDate(sunday2), '2026-08-02');
console.log('isoWeekBounds (today=Sunday): ok');

console.log('ALL DATE HELPER TESTS PASSED');
