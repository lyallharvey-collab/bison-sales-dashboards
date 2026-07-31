/**
 * Tests static/views.js. It's a classic browser script, so it's evaluated here
 * with a fake `self` rather than imported — that keeps the browser file free of
 * module plumbing while still making the maths testable.
 *
 * Evaluated in THIS realm (new Function) rather than a vm context on purpose:
 * a vm gets its own Array.prototype, so deepStrictEqual rejects arrays that are
 * value-identical.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../static/views.js', import.meta.url), 'utf8');
const fakeGlobal = {};
// eslint-disable-next-line no-new-func
new Function('self', src)(fakeGlobal);
const DV = fakeGlobal.DashboardViews;
assert.ok(DV, 'views.js should attach DashboardViews to the global');

// A month of 5 business days. Target 100/day cumulative; actuals stop at day 3.
const panel = {
  labels: ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'],
  unit: 'currency',
  series: [
    { key: 'target', label: 'Target', color: '#8e24aa', is_reference: true, data: [100, 200, 300, 400, 500] },
    { key: 'orders', label: 'Orders', color: '#1e88e5', is_reference: false, data: [80, 190, 240, null, null] },
  ],
};

// --- mode: URL only, and anything unrecognised means desktop -----------------
assert.strictEqual(DV.readMode('?mode=kiosk'), 'kiosk');
assert.strictEqual(DV.readMode('?mode=KIOSK'), 'desktop'); // exact match only
assert.strictEqual(DV.readMode(''), 'desktop');
assert.strictEqual(DV.readMode('?mode=nonsense'), 'desktop');
assert.strictEqual(DV.readView('?view=variance'), 'variance');
assert.strictEqual(DV.readView('?view=pie'), 'cumulative'); // unknown -> safe default
console.log('mode/view parsing: ok');

// --- daily: successive differences, nulls preserved --------------------------
const daily = DV.applyView(panel, 'daily');
assert.deepStrictEqual(daily.series[0].data, [100, 100, 100, 100, 100]);
assert.deepStrictEqual(daily.series[1].data, [80, 110, 50, null, null]);
assert.strictEqual(daily.zeroBaseline, true);
// A day's contribution is a magnitude to compare, so actuals become columns;
// the targets stay as lines because they're the threshold being judged against.
assert.strictEqual(daily.series[0].mark, 'line', 'target stays a line');
assert.strictEqual(daily.series[1].mark, 'bar', 'actual becomes a column');
console.log('daily differences + marks: ok');

// --- variance: actual minus the reference, reference series dropped ----------
const variance = DV.applyView(panel, 'variance');
// One series only: colour has to carry SIGN here, so it can't also carry
// identity for several series at once.
assert.strictEqual(variance.series.length, 1);
assert.deepStrictEqual(variance.series[0].data, [-20, -10, -60, null, null]);
assert.strictEqual(variance.zeroBaseline, true);
assert.match(variance.series[0].label, /vs target/);
// Form, not just numbers: above/below a baseline wants diverging columns.
assert.strictEqual(variance.series[0].mark, 'bar');
assert.strictEqual(variance.series[0].colorBySign, true);
console.log('variance vs target (diverging bars): ok');

// --- projection: joins the actual endpoint, then extrapolates ----------------
const proj = DV.applyView(panel, 'projection');
const projected = proj.series.find((s) => s.is_projection);
assert.ok(projected, 'a projected twin should be added');
// Original series must be untouched.
assert.deepStrictEqual(proj.series[1].data, [80, 190, 240, null, null]);
// Run rate = 240/3 = 80/day. Projection starts AT the last actual point (240)
// so the dashed segment continues the solid line instead of jumping.
assert.strictEqual(projected.data[0], null);
assert.strictEqual(projected.data[2], 240);
assert.strictEqual(projected.data[3], 320);
assert.strictEqual(projected.data[4], 400);
console.log('projection continuity: ok');

// --- summarise: the numbers a kiosk shows as text ---------------------------
const s = DV.summarise(panel);
assert.strictEqual(s.dayNow, 3);
assert.strictEqual(s.dayTotal, 5);
assert.strictEqual(s.daysRemaining, 2);
assert.strictEqual(s.targetFinal, 500);
assert.strictEqual(s.primaryNow, 240);
assert.strictEqual(s.runRate, 80);
assert.strictEqual(s.projectedFinish, 400);
assert.strictEqual(s.perDayNeeded, 130); // (500-240)/2 — needs the FULL target
assert.strictEqual(s.projectedPctOfTarget, 0.8);

// The distinction that stops the headline number being misleading: every row
// reports where it stands TODAY, not at period end.
assert.strictEqual(s.targetToDate, 300, 'target as at today');
assert.strictEqual(s.targetFinal, 500, 'target for the whole period');
const tRow = s.series.find((x) => x.key === 'target');
const oRow = s.series.find((x) => x.key === 'orders');
assert.strictEqual(tRow.value, 300, 'pace line reports its to-date position');
assert.strictEqual(tRow.periodEndValue, 500, 'period-end figure still available');
assert.strictEqual(oRow.value, 240);
// 240/300 = 80% of where we should be. Against the full 500 it would read 48%,
// which is the misleading version.
assert.strictEqual(oRow.pctOfTarget, 0.8);
assert.strictEqual(oRow.periodEndValue, null, 'actuals have no period-end figure');
console.log('summarise (to-date vs period-end): ok');

// --- the last-business-day case that caused the all-dashed bug --------------
// Every series is gap-free, so gap-sniffing would call the actual a reference.
// The explicit flag must win.
const full = {
  labels: ['2026-07-30', '2026-07-31'],
  series: [
    { key: 'target', label: 'Target', is_reference: true, data: [100, 200] },
    { key: 'orders', label: 'Orders', is_reference: false, data: [90, 180] },
  ],
};
assert.strictEqual(DV.isReference(full.series[1]), false);
assert.strictEqual(DV.summarise(full).daysRemaining, 0);
assert.strictEqual(DV.summarise(full).perDayNeeded, null, 'no divide-by-zero on the final day');
console.log('final-day / no days remaining: ok');

// --- degenerate inputs: the data-less shell, and all-null series ------------
const shell = { labels: [], series: [] };
assert.doesNotThrow(() => DV.applyView(shell, 'variance'));
assert.doesNotThrow(() => DV.summarise(shell));
const allNull = {
  labels: ['a', 'b'],
  series: [{ key: 'o', label: 'O', is_reference: false, data: [null, null] }],
};
assert.doesNotThrow(() => DV.applyView(allNull, 'projection'));
assert.strictEqual(DV.summarise(allNull).runRate, null);
// No reference series -> variance has nothing to compare against, so it must
// fall back rather than fabricate a zero baseline.
assert.strictEqual(DV.applyView(allNull, 'variance').view, 'cumulative');
assert.ok(DV.STATUS.good && DV.STATUS.bad, 'status colours exposed for the diverging view');
console.log('degenerate inputs: ok');

console.log('ALL VIEW DERIVATION TESTS PASSED');
