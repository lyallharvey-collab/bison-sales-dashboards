import { isoDate, monthBounds, businessDaysInRange } from './dates.js';
import { readGroupDaily, foldWeekendsIntoPriorBusinessDay, cumulativeOverBuckets } from './dataSources.js';
import { COMPOSITE_SOURCES } from './specialSources.js';

async function dailyForSeries(client, s, monthStart, monthEnd, today, dayTo) {
  let daily;
  if (s.source === 'read_group') {
    if (!(s.model && s.dateField && s.measure)) {
      throw new Error(`series '${s.key}': read_group source needs model/dateField/measure`);
    }
    daily = await readGroupDaily(client, s.model, s.domain, s.dateField, s.measure, monthStart, dayTo);
  } else if (COMPOSITE_SOURCES[s.source]) {
    daily = await COMPOSITE_SOURCES[s.source](client, monthStart, monthEnd, today);
    const dayToIso = isoDate(dayTo);
    for (const key of [...daily.keys()]) {
      if (key > dayToIso) daily.delete(key);
    }
  } else {
    throw new Error(`series '${s.key}': unknown source '${s.source}'`);
  }
  // monthStart lets the fold detect a weekend that would roll out of the month.
  return foldWeekendsIntoPriorBusinessDay(daily, monthStart);
}

/** Mirrors build.py's build_dashboard exactly: daily/business-day granularity,
 * current month, weekends folded backward into Friday. */
export async function buildSalesGraphPayload(client, cfg, today) {
  const [monthStart, monthEnd] = monthBounds(today);
  const businessDays = businessDaysInRange(monthStart, monthEnd);

  // Fetched in parallel rather than one series at a time: these are
  // independent queries, and serialising them made a request take seconds of
  // wall clock for no reason. The client dedups identical calls, so overlapping
  // series that need the same data still only ask Odoo once.
  const fetched = await Promise.all(cfg.series.map((s) => {
    const dayTo = s.extend ? monthEnd : today;
    return dailyForSeries(client, s, monthStart, monthEnd, today, dayTo)
      .then((daily) => ({ s, dayTo, daily }));
  }));

  const seriesOut = [];
  const latest = {};
  for (const { s, dayTo, daily } of fetched) {
    let values;
    if (s.cumulative) {
      const bucketsThrough = businessDays.filter((d) => d <= dayTo);
      values = cumulativeOverBuckets(daily, bucketsThrough);
    } else {
      values = daily;
    }

    const dataPoints = businessDays.map((d) => {
      const key = isoDate(d);
      return values.has(key) ? values.get(key) : null;
    });
    // is_reference stated explicitly, not inferred from gaps: on the last
    // business day of the month the actuals have no gaps either.
    seriesOut.push({ key: s.key, label: s.label, color: s.color, data: dataPoints, is_reference: !!s.extend });
    const nonNull = dataPoints.filter((v) => v !== null);
    latest[s.key] = nonNull.length ? nonNull[nonNull.length - 1] : 0;
  }

  return {
    generated_at: new Date().toISOString(),
    name: cfg.name,
    title: cfg.title,
    chart_type: cfg.chartType,
    unit: cfg.unit,
    currency_symbol: cfg.currencySymbol,
    theme: cfg.theme,
    logo_url: cfg.logoUrl ?? null,
    refresh_seconds: cfg.refreshSeconds,
    labels: businessDays.map(isoDate),
    series: seriesOut,
    latest,
  };
}
