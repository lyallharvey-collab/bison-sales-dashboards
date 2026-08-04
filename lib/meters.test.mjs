import assert from 'node:assert';
import { toUTCDate, isoDate } from './dates.js';
import { DIVISIONS, MEASURES, assembleMeters, meterBounds } from './divisionSources.js';

// --- the mapping itself ----------------------------------------------------
// There are exactly three crm.team records in Odoo, so this is a closed set.
// If a fourth division ever appears, this assertion is the reminder that the
// target field and the TOTAL reconciliation both need looking at.
assert.deepStrictEqual(DIVISIONS.map((d) => d.key), ['machinery', 'consumables', 'sas']);
assert.deepStrictEqual(DIVISIONS.map((d) => d.teamId), [5, 7, 6]);
console.log('DIVISIONS mapping: ok');

// --- period bounds ---------------------------------------------------------
// x_daily_sales_targets has NO weekend rows, so a Saturday must roll back to
// Friday or the meter divides by a zero target.
const tue = toUTCDate(2026, 7, 4);   // 2026-08-04 is a Tuesday
let [from, to] = meterBounds('day', tue);
assert.strictEqual(isoDate(from), '2026-08-04');
assert.strictEqual(isoDate(to), '2026-08-04');

const sat = toUTCDate(2026, 7, 8);   // 2026-08-08 is a Saturday
[from, to] = meterBounds('day', sat);
assert.strictEqual(isoDate(from), '2026-08-07'); // back to Friday, so there IS a target
assert.strictEqual(isoDate(to), '2026-08-08');   // ...and Saturday's orders still count

const sun = toUTCDate(2026, 7, 9);
[from, to] = meterBounds('day', sun);
assert.strictEqual(isoDate(from), '2026-08-07');
assert.strictEqual(isoDate(to), '2026-08-09');

// Month is to-date on BOTH sides — never actual-to-date against a full-month
// target, which reads as a miss when the pace is fine.
[from, to] = meterBounds('month', tue);
assert.strictEqual(isoDate(from), '2026-08-01');
assert.strictEqual(isoDate(to), '2026-08-04');
console.log('meterBounds: ok');

// divisionMeters() rejects an unknown period before it gets here, so
// meterBounds itself just treats anything that isn't 'month' as a day.
assert.deepStrictEqual(meterBounds('week', tue).map(isoDate), ['2026-08-04', '2026-08-04']);
console.log('meterBounds non-month falls back to day: ok');

// --- assembleMeters --------------------------------------------------------
const TARGETS = {
  x_studio_machinery_daily_target: 30400,
  x_studio_consumables_daily_target: 7200,
  x_studio_sas_daily_target: 4800,
  x_studio_company_daily_target: 42400,
};

// The 2023 sheet's actual numbers, which is the case this panel exists for:
// 72% overall was 72% / 7% / 231% underneath.
const rows = assembleMeters(TARGETS, new Map([[5, 21888], [7, 504], [6, 11088]]));
assert.strictEqual(rows.length, 4);
assert.deepStrictEqual(rows.map((r) => r.key), ['machinery', 'consumables', 'sas', 'total']);
assert.strictEqual(Math.round(rows[0].pct * 100), 72);
assert.strictEqual(Math.round(rows[1].pct * 100), 7);
assert.strictEqual(Math.round(rows[2].pct * 100), 231);
assert.strictEqual(rows[3].label, 'TOTAL');
assert.strictEqual(rows[3].actual, 21888 + 504 + 11088);
assert.strictEqual(rows[3].target, 42400);
assert.strictEqual(rows[3].is_total, true);
assert.strictEqual(rows[0].is_total, false);
console.log('assembleMeters (the 2023 case): ok');

// A team with no activity is 0%, not missing.
const quiet = assembleMeters(TARGETS, new Map([[5, 1000]]));
assert.strictEqual(quiet[1].actual, 0);
assert.strictEqual(quiet[1].pct, 0);
assert.strictEqual(quiet[3].actual, 1000);
console.log('assembleMeters (idle division): ok');

// Unmapped / team-less records must still reach TOTAL, or the parts silently
// stop adding up to the whole — the one thing a reconciliation panel can't do.
const stray = assembleMeters(TARGETS, new Map([[5, 1000], [0, 250], [99, 400]]));
assert.strictEqual(stray[3].actual, 1650);
assert.strictEqual(stray[0].actual + stray[1].actual + stray[2].actual, 1000);
console.log('assembleMeters (unattributed remainder reaches TOTAL): ok');

// No target set => pct is null, NOT 0 and NOT Infinity. "We have no target" and
// "we achieved 0% of target" are different statements.
const noTarget = assembleMeters({}, new Map([[5, 5000]]));
assert.strictEqual(noTarget[0].pct, null);
assert.strictEqual(noTarget[0].target, 0);
assert.strictEqual(noTarget[3].pct, null);
console.log('assembleMeters (zero target => null pct): ok');

// --- measures --------------------------------------------------------------
// Colour follows the entity: these must stay the same hexes the Orders and
// Invoiced lines use on the charts, or the same measure changes colour between
// two pages of the same dashboard set.
assert.strictEqual(MEASURES.orders.color, '#1e88e5');
assert.strictEqual(MEASURES.invoiced.color, '#43a047');
console.log('MEASURES colours match the chart series: ok');

console.log('ALL DIVISION METER TESTS PASSED');
