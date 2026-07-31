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
console.log('daily differences: ok');

// --- variance: actual minus the reference, reference series dropped ----------
const variance = DV.applyView(panel, 'variance');
assert.strictEqual(variance.series.length, 1, 'reference series should not appear as its own variance');
assert.deepStrictEqual(variance.series[0].data, [-20, -10, -60, null, null]);
assert.strictEqual(variance.zeroBaseline, true);
assert.match(variance.series[0].label, /vs target/);
console.log('variance vs target: ok');

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
assert.strictEqual(s.perDayNeeded, 130); // (500-240)/2
assert.strictEqual(s.projectedPctOfTarget, 0.8);
// Reference series report their month-end figure; actuals report today's.
assert.strictEqual(s.series.find((x) => x.key === 'target').value, 500);
assert.strictEqual(s.series.find((x) => x.key === 'orders').value, 240);
console.log('summarise: ok');

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
console.log('degenerate inputs: ok');

// --- direct-label collision resolution --------------------------------------
// Lines converge near month-end, so labels land on top of each other unless
// they're pushed apart (Breakeven and Invoiced overlapped in a real render).
{
  const items = [{ y: 100, t: 'a' }, { y: 104, t: 'b' }, { y: 106, t: 'c' }];
  const out = DV.layoutLabels(items, 0, 500, 20);
  assert.deepStrictEqual(out.map((i) => i.y), [100, 120, 140]);
  assert.deepStrictEqual(out.map((i) => i.t), ['a', 'b', 'c'], 'vertical order preserved');
}
{
  // Stack would run off the bottom -> whole stack shifts up, none clipped.
  const out = DV.layoutLabels([{ y: 480 }, { y: 485 }, { y: 490 }], 0, 500, 20);
  assert.ok(out[out.length - 1].y <= 500, 'last label inside the plot');
  assert.deepStrictEqual(out.map((i) => i.y), [460, 480, 500]);
}
{
  // Already far apart -> untouched.
  const out = DV.layoutLabels([{ y: 50 }, { y: 200 }], 0, 500, 20);
  assert.deepStrictEqual(out.map((i) => i.y), [50, 200]);
}
{
  // Taller stack than the plot: clamps to the top rather than going negative.
  const many = Array.from({ length: 6 }, (_, i) => ({ y: 10 + i }));
  const out = DV.layoutLabels(many, 0, 50, 20);
  assert.ok(out[0].y >= 0, 'first label not above the plot');
}
assert.doesNotThrow(() => DV.layoutLabels([], 0, 100, 20));
console.log('direct-label collision layout: ok');

console.log('ALL VIEW DERIVATION TESTS PASSED');
