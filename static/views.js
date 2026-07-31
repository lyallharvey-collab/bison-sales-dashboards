/**
 * Dashboard view derivations + mode plumbing.
 *
 * Everything here is a pure transform of a payload the Pages Function already
 * returns, so switching view costs no Odoo query, no round trip and no CPU
 * budget. That is the whole point: the desktop mode can offer several ways of
 * reading the month without touching the data path.
 *
 * Loaded as a classic script (sets window.DashboardViews) rather than a module,
 * so the templates' existing inline scripts can use it without becoming modules
 * and without any load-order surprises. Node can still test it — see
 * lib/views.test.mjs, which runs this file in a vm.
 *
 * Two deliberate omissions, both anti-patterns:
 *   - No "chart type" switch. Views are named by the QUESTION they answer, so
 *     each one pins the correct form. A free type picker is how you end up
 *     plotting cumulative money as bars, or two scales on one axis.
 *   - No second y-axis, ever.
 */
(function (global) {
  'use strict';

  // --------------------------------------------------------------- mode/view
  // Read from the URL, never from persisted state: a wall screen must come
  // back to the same view after a reload, a power cut, or the 6h safety
  // refresh, and nothing done at a desk should be able to change it.
  function readMode(search) {
    var m = new URLSearchParams(search || '').get('mode');
    return m === 'kiosk' ? 'kiosk' : 'desktop';
  }

  var VIEW_ORDER = ['cumulative', 'daily', 'variance', 'projection'];
  var VIEW_LABELS = {
    cumulative: 'Cumulative',
    daily: 'Per day',
    variance: 'Vs target',
    projection: 'Projection',
  };
  var VIEW_HINTS = {
    cumulative: 'Running total against the target and breakeven pace',
    daily: 'What each day actually contributed',
    variance: 'How far ahead or behind target, day by day',
    projection: 'Where the month lands at the current run rate',
  };

  function readView(search, fallback) {
    var v = new URLSearchParams(search || '').get('view');
    return VIEW_ORDER.indexOf(v) >= 0 ? v : (fallback || 'cumulative');
  }

  // ------------------------------------------------------------------ helpers
  var isNum = function (v) { return v !== null && v !== undefined && !Number.isNaN(v); };

  function lastFilledIndex(data) {
    var i = -1;
    (data || []).forEach(function (v, k) { if (isNum(v)) i = k; });
    return i;
  }

  function lastFilledValue(data) {
    var i = lastFilledIndex(data);
    return i < 0 ? null : data[i];
  }

  function isReference(s) {
    return (s.is_reference !== undefined && s.is_reference !== null)
      ? !!s.is_reference
      : ((s.data || []).length > 0 && s.data.every(isNum));
  }

  function splitSeries(panel) {
    var all = (panel && panel.series) || [];
    return {
      refs: all.filter(isReference),
      actuals: all.filter(function (s) { return !isReference(s); }),
    };
  }

  // --------------------------------------------------------------- transforms
  // Series arrive cumulative, so a per-day value is just the step between
  // consecutive points — no extra query needed.
  function toDaily(data) {
    var out = [];
    var prev = 0;
    for (var i = 0; i < data.length; i++) {
      var v = data[i];
      if (!isNum(v)) { out.push(null); continue; }
      out.push(v - prev);
      prev = v;
    }
    return out;
  }

  function subtract(actual, baseline) {
    return actual.map(function (v, i) {
      return (isNum(v) && isNum(baseline[i])) ? v - baseline[i] : null;
    });
  }

  /** Straight-line continuation from the last actual point at the run rate
   * achieved so far. Starts exactly on the actual's endpoint by construction,
   * so the projected segment joins the real line rather than jumping. */
  function projectForward(data, totalPoints) {
    var idx = lastFilledIndex(data);
    if (idx < 0) return data.map(function () { return null; });
    var runRate = data[idx] / (idx + 1);
    var out = [];
    for (var i = 0; i < totalPoints; i++) {
      out.push(i < idx ? null : runRate * (i + 1));
    }
    return out;
  }

  /**
   * Transform a payload (or a single multi-dashboard panel) for a named view.
   * Returns the same shape the renderer already consumes, plus:
   *   view          the view actually applied
   *   zeroBaseline  true when 0 is meaningful and should be drawn
   */
  function applyView(panel, viewName) {
    var view = VIEW_ORDER.indexOf(viewName) >= 0 ? viewName : 'cumulative';
    var labels = (panel && panel.labels) || [];
    var parts = splitSeries(panel);

    // Nothing to derive from (e.g. the data-less shell before first fetch).
    if (!labels.length || !(panel.series || []).length) {
      return Object.assign({}, panel, { view: 'cumulative', zeroBaseline: false });
    }

    if (view === 'daily') {
      return Object.assign({}, panel, {
        view: view,
        zeroBaseline: true,
        series: panel.series.map(function (s) {
          return Object.assign({}, s, { data: toDaily(s.data) });
        }),
      });
    }

    if (view === 'variance') {
      var baseline = parts.refs[0];
      // Without a reference series there is nothing to be "vs", so fall back
      // rather than inventing a baseline of zero.
      if (!baseline) return applyView(panel, 'cumulative');
      return Object.assign({}, panel, {
        view: view,
        zeroBaseline: true,
        baseline_label: baseline.label,
        series: parts.actuals.map(function (s) {
          return Object.assign({}, s, {
            data: subtract(s.data, baseline.data),
            is_reference: false,
            label: s.label + ' vs ' + baseline.label.toLowerCase(),
          });
        }),
      });
    }

    if (view === 'projection') {
      var projected = parts.actuals.map(function (s) {
        return Object.assign({}, s, {
          key: s.key + '__projected',
          label: s.label + ' (projected)',
          data: projectForward(s.data, labels.length),
          is_reference: false,
          is_projection: true,
        });
      });
      return Object.assign({}, panel, {
        view: view,
        zeroBaseline: false,
        series: panel.series.concat(projected),
      });
    }

    return Object.assign({}, panel, { view: 'cumulative', zeroBaseline: false });
  }

  /**
   * The numbers a kiosk screen should show as text rather than make someone
   * read off an axis. Derived from the same payload; no extra query.
   */
  function summarise(panel) {
    var labels = (panel && panel.labels) || [];
    var parts = splitSeries(panel);
    var primary = parts.actuals[0] || null;
    var baseline = parts.refs[0] || null;

    var dayTotal = labels.length;
    var idx = parts.actuals.length
      ? Math.max.apply(null, parts.actuals.map(function (s) { return lastFilledIndex(s.data); }))
      : dayTotal - 1;
    var dayNow = idx + 1;
    var daysRemaining = Math.max(0, dayTotal - dayNow);

    var targetFinal = baseline ? lastFilledValue(baseline.data) : null;
    var primaryNow = primary ? primary.data[idx] : null;

    var perDayNeeded = (isNum(targetFinal) && isNum(primaryNow) && daysRemaining > 0)
      ? (targetFinal - primaryNow) / daysRemaining
      : null;
    var runRate = (isNum(primaryNow) && dayNow > 0) ? primaryNow / dayNow : null;
    var projectedFinish = isNum(runRate) ? runRate * dayTotal : null;

    return {
      dayNow: dayNow,
      dayTotal: dayTotal,
      daysRemaining: daysRemaining,
      baselineKey: baseline ? baseline.key : null,
      baselineLabel: baseline ? baseline.label : null,
      targetFinal: targetFinal,
      primaryKey: primary ? primary.key : null,
      primaryNow: primaryNow,
      runRate: runRate,
      perDayNeeded: perDayNeeded,
      projectedFinish: projectedFinish,
      projectedPctOfTarget: (isNum(projectedFinish) && targetFinal)
        ? projectedFinish / targetFinal : null,
      series: (panel.series || []).map(function (s) {
        var value = isReference(s) ? lastFilledValue(s.data) : s.data[idx];
        return {
          key: s.key,
          label: s.label,
          color: s.color,
          is_reference: isReference(s),
          value: isNum(value) ? value : null,
          pctOfTarget: (isNum(value) && targetFinal) ? value / targetFinal : null,
        };
      }),
    };
  }

  /**
   * Push a set of direct labels apart so they never overlap.
   *
   * Needed because several lines converge near the right-hand side by
   * month-end — Breakeven and Invoiced landed on top of each other, which is
   * exactly the clipped/collided label case that makes direct labelling worse
   * than no labelling. Keeps original order by y, spaces them by minGap, then
   * shifts the whole stack back inside [top, bottom] if it overflowed.
   *
   * Mutates and returns the items, sorted by final y.
   */
  function layoutLabels(items, top, bottom, minGap) {
    var sorted = items.slice().sort(function (a, b) { return a.y - b.y; });
    var prev = -Infinity;
    sorted.forEach(function (it) {
      it.y = Math.max(it.y, prev + minGap);
      prev = it.y;
    });
    if (sorted.length) {
      var over = sorted[sorted.length - 1].y - bottom;
      if (over > 0) sorted.forEach(function (it) { it.y -= over; });
      var under = top - sorted[0].y;
      if (under > 0) sorted.forEach(function (it) { it.y += under; });
    }
    return sorted;
  }

  var API = {
    layoutLabels: layoutLabels,
    readMode: readMode,
    readView: readView,
    VIEW_ORDER: VIEW_ORDER,
    VIEW_LABELS: VIEW_LABELS,
    VIEW_HINTS: VIEW_HINTS,
    applyView: applyView,
    summarise: summarise,
    lastFilledIndex: lastFilledIndex,
    isReference: isReference,
    toDaily: toDaily,
    projectForward: projectForward,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else global.DashboardViews = API;
})(typeof self !== 'undefined' ? self : this);
