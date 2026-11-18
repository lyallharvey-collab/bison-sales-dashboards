import assert from 'node:assert';
import { toUTCDate, isoDate } from './dates.js';
import {
  REPS, CATEGORIES, PERIODS, ACTIVITY_TYPES, categoryOf, periodBounds, periodDomain, assembleActivity,
} from './activitySources.js';

// --- who and what ----------------------------------------------------------
// The board's people, by partner id. A change here is a change to who is on
// the TV, so it should be a deliberate edit to this assertion too.
assert.deepStrictEqual(REPS.map((r) => r.partnerId), [132062, 132063, 132068, 132070, 134942, 132751]);
assert.deepStrictEqual(PERIODS.map((p) => p.key), ['week', 'last_week', 'month', 'ytd']);
console.log('reps and periods: ok');

// --- Lyall's points rule ---------------------------------------------------
// Calls 1 whether contacted or not; visits 1, or 5 when Contacted Call is
// ticked; showroom 5 regardless.
assert.strictEqual(categoryOf(ACTIVITY_TYPES.callOut, false), 'calls_out');
assert.strictEqual(categoryOf(ACTIVITY_TYPES.callOut, true), 'calls_out');
assert.strictEqual(categoryOf(ACTIVITY_TYPES.callIn, true), 'calls_in');
assert.strictEqual(categoryOf(ACTIVITY_TYPES.appointment, true), 'visits_contacted');
assert.strictEqual(categoryOf(ACTIVITY_TYPES.appointment, false), 'visits_not_contacted');
assert.strictEqual(categoryOf(ACTIVITY_TYPES.siteDemo, true), 'visits_contacted');   // a site visit
assert.strictEqual(categoryOf(ACTIVITY_TYPES.showroom, false), 'showroom');
assert.strictEqual(categoryOf(34, true), null);   // Online Meeting: not counted
assert.strictEqual(categoryOf(1, false), null);   // Email: not counted
assert.strictEqual(categoryOf(4, false), null);   // Action: not counted
const pointsOf = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.points]));
assert.deepStrictEqual(pointsOf, {
  calls_out: 1, calls_in: 1, visits_contacted: 5, visits_not_contacted: 1, showroom: 5,
});
console.log('categoryOf and points: ok');

// --- assembly from read_group rows -----------------------------------------
// Simon's real week of 9 Nov 2026: 125 out, 16 in, 16 contacted visits, 4 not
// contacted, 4 showroom = 125 + 16 + 80 + 4 + 20 = 245 points from 165.
const simon = [132070, 'Bison Machinery Ltd, Simon Harvey'];
const groups = [
  { author_id: simon, mail_activity_type_id: [17, 'Phone Call Out'], contacted_call: false, __count: 70 },
  { author_id: simon, mail_activity_type_id: [17, 'Phone Call Out'], contacted_call: true, __count: 55 },
  { author_id: simon, mail_activity_type_id: [2, 'Phone Call In'], contacted_call: true, __count: 16 },
  { author_id: simon, mail_activity_type_id: [3, 'Appointment'], contacted_call: true, __count: 16 },
  { author_id: simon, mail_activity_type_id: [3, 'Appointment'], contacted_call: false, __count: 4 },
  { author_id: simon, mail_activity_type_id: [18, 'Showroom Visit'], contacted_call: false, __count: 4 },
  // Ignored: someone not on the board, and a type that isn't counted.
  { author_id: [133910, 'Pentaro'], mail_activity_type_id: [17, 'Phone Call Out'], contacted_call: false, __count: 300 },
  { author_id: simon, mail_activity_type_id: [34, 'Online Meeting'], contacted_call: true, __count: 9 },
];
const a = assembleActivity(groups);
const s = a.reps.find((r) => r.key === 'simon');
assert.deepStrictEqual(s.counts, {
  calls_out: 125, calls_in: 16, visits_contacted: 16, visits_not_contacted: 4, showroom: 4,
});
assert.strictEqual(s.points, 245);
assert.strictEqual(s.activities, 165);
// Everyone is on the board even with nothing logged, in REPS order.
assert.deepStrictEqual(a.reps.map((r) => r.key), REPS.map((r) => r.key));
assert.strictEqual(a.reps.find((r) => r.key === 'roddy').points, 0);
// Team totals are the reps' sum — Pentaro's 300 calls don't leak in.
assert.strictEqual(a.points, 245);
assert.strictEqual(a.totals.calls_out, 125);
console.log('assembleActivity: ok');

// --- period bounds ---------------------------------------------------------
const wed = toUTCDate(2026, 10, 18);   // Wed 18 Nov 2026
const b = (k, d) => periodBounds(k, d).map(isoDate);
assert.deepStrictEqual(b('week', wed), ['2026-11-16', '2026-11-18']);
assert.deepStrictEqual(b('last_week', wed), ['2026-11-09', '2026-11-15']);
assert.deepStrictEqual(b('month', wed), ['2026-11-01', '2026-11-18']);
assert.deepStrictEqual(b('ytd', wed), ['2026-01-01', '2026-11-18']);
// Monday: this week is just today, last week is the whole previous Mon–Sun.
const mon = toUTCDate(2026, 10, 16);
assert.deepStrictEqual(b('week', mon), ['2026-11-16', '2026-11-16']);
assert.deepStrictEqual(b('last_week', mon), ['2026-11-09', '2026-11-15']);
// Sunday still belongs to the week that started the Monday before.
const sun = toUTCDate(2026, 10, 22);
assert.deepStrictEqual(b('week', sun), ['2026-11-16', '2026-11-22']);
// Early January: last week reaches back into the previous year.
const jan = toUTCDate(2027, 0, 5);     // Tue 5 Jan 2027
assert.deepStrictEqual(b('last_week', jan), ['2026-12-28', '2027-01-03']);
assert.deepStrictEqual(b('ytd', jan), ['2027-01-01', '2027-01-05']);
assert.throws(() => periodBounds('fortnight', wed));
console.log('periodBounds: ok');

// The upper bound is EXCLUSIVE midnight after the last day — inclusive "<= day"
// on a datetime would drop everything after 00:00:00 on it.
const dom = periodDomain(toUTCDate(2026, 10, 16), toUTCDate(2026, 10, 18));
assert.deepStrictEqual(dom.slice(2), [['date', '>=', '2026-11-16 00:00:00'], ['date', '<', '2026-11-19 00:00:00']]);
console.log('periodDomain: ok');

// --- colours ---------------------------------------------------------------
// Every segment's label ink must clear 4.5:1 on its fill (the desktop labels
// are below the large-text size), and no fill may borrow Target purple or the
// status green/red, which mean something else on every page.
function luminance(hex) {
  const [r, g, bb] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * bb;
}
const contrast = (x, y) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
for (const c of CATEGORIES) {
  const ratio = contrast(c.color, c.ink);
  assert.ok(ratio >= 4.5, `${c.key}: ink contrast ${ratio.toFixed(2)} < 4.5`);
  assert.ok(!['#8e24aa', '#0ca30c', '#d03b3b'].includes(c.color.toLowerCase()), `${c.key} uses a reserved colour`);
}
console.log('category colours: ok');
