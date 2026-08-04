import { isoDate, toUTCDate, yearBounds, MONTH_NAMES } from './dates.js';
import { readGroupMonthly, cumulativeOverBuckets } from './dataSources.js';
import { COMPOSITE_SOURCES } from './specialSources.js';
import { KPI_SOURCES, TABLE_SOURCES } from './crmSources.js';
import { divisionMeters } from './divisionSources.js';
import { buildSalesGraphPayload } from './buildSalesGraph.js';

async function buildDailyLineChartPanel(client, panel, today) {
  const raw = await buildSalesGraphPayload(client, {
    name: panel.id, title: panel.title, chartType: panel.chartType,
    unit: panel.unit, currencySymbol: panel.currencySymbol, theme: {},
    series: panel.series, refreshSeconds: 0,
  }, today);
  return {
    title: panel.title, chart_type: raw.chart_type, unit: raw.unit,
    currency_symbol: raw.currency_symbol, labels: raw.labels,
    series: raw.series, latest: raw.latest,
  };
}

async function buildMonthlyLineChartPanel(client, panel, today) {
  const [yearStart, yearEnd] = yearBounds(today);
  const months = [];
  for (let m = 0; m < 12; m++) months.push(toUTCDate(today.getUTCFullYear(), m, 1));

  // Parallel for the same reason as the daily chart — see buildSalesGraph.js.
  const fetched = await Promise.all(panel.series.map(async (s) => {
    const monthTo = s.extend ? yearEnd : today;

    let monthly;
    if (s.source === 'read_group') {
      if (!(s.model && s.dateField && s.measure)) {
        throw new Error(`panel '${panel.id}' series '${s.key}': read_group needs model/dateField/measure`);
      }
      monthly = await readGroupMonthly(client, s.model, s.domain, s.dateField, s.measure, yearStart, monthTo);
    } else if (COMPOSITE_SOURCES[s.source]) {
      monthly = await COMPOSITE_SOURCES[s.source](client, yearStart, yearEnd, today);
      const monthToIso = isoDate(monthTo);
      for (const key of [...monthly.keys()]) {
        if (key > monthToIso) monthly.delete(key);
      }
    } else {
      throw new Error(`panel '${panel.id}' series '${s.key}': unknown source '${s.source}'`);
    }
    return { s, monthTo, monthly };
  }));

  const seriesOut = [];
  const latest = {};
  for (const { s, monthTo, monthly } of fetched) {
    let values;
    if (s.cumulative) {
      const monthsThrough = months.filter((m) => m <= monthTo);
      values = cumulativeOverBuckets(monthly, monthsThrough);
    } else {
      values = monthly;
    }

    const dataPoints = months.map((m) => {
      const key = isoDate(m);
      return values.has(key) ? values.get(key) : null;
    });
    seriesOut.push({ key: s.key, label: s.label, color: s.color, data: dataPoints, is_reference: !!s.extend });
    const nonNull = dataPoints.filter((v) => v !== null);
    latest[s.key] = nonNull.length ? nonNull[nonNull.length - 1] : 0;
  }

  return {
    title: panel.title, chart_type: panel.chartType, unit: panel.unit,
    currency_symbol: panel.currencySymbol,
    labels: months.map((m) => MONTH_NAMES[m.getUTCMonth()]),
    series: seriesOut, latest,
  };
}

async function buildKpiPanel(client, panel, today) {
  const fn = KPI_SOURCES[panel.source];
  if (!fn) throw new Error(`panel '${panel.id}': unknown kpi source '${panel.source}'`);
  const value = await fn(client, today);
  return { title: panel.title, value, caption: panel.caption || panel.title };
}

/** A meter is one ratio against a limit, not a chart — so it carries scalars,
 * no labels/series. Rendered as CSS tubes, not Chart.js. */
async function buildMeterGroupPanel(client, panel, today) {
  const m = await divisionMeters(client, { period: panel.period, measure: panel.measure }, today);
  return {
    title: panel.title,
    unit: panel.unit,
    currency_symbol: panel.currencySymbol,
    measure: m.measure,
    measure_label: m.measure_label,
    period: m.period,
    period_label: m.period_label,
    color: m.color,
    period_from: m.period_from,
    period_to: m.period_to,
    meters: m.meters,
  };
}

async function buildTablePanel(client, panel) {
  const fn = TABLE_SOURCES[panel.source];
  if (!fn) throw new Error(`panel '${panel.id}': unknown table source '${panel.source}'`);
  const rows = await fn(client);
  return { title: panel.title, columns: panel.columns, rows };
}

/** Mirrors multi_build.py's build_multi_dashboard. */
export async function buildMultiDashboardPayload(client, cfg, today) {
  // Panels are independent, so build them concurrently. Combined with the
  // parallel series fetches and the client's call dedup, a 4-panel dashboard
  // issues its queries in a couple of waves instead of a long chain.
  const panelsOut = await Promise.all(cfg.panels.map(async (p) => {
    const theme = { ...cfg.theme, ...p.theme };
    let body;
    if (p.type === 'line_chart') {
      body = p.granularity === 'month'
        ? await buildMonthlyLineChartPanel(client, p, today)
        : await buildDailyLineChartPanel(client, p, today);
    } else if (p.type === 'kpi') {
      body = await buildKpiPanel(client, p, today);
    } else if (p.type === 'meter_group') {
      body = await buildMeterGroupPanel(client, p, today);
    } else if (p.type === 'table') {
      body = await buildTablePanel(client, p);
    } else {
      throw new Error(`panel '${p.id}': unknown type '${p.type}'`);
    }
    return { id: p.id, type: p.type, theme, col: p.col, flex: p.flex, ...body };
  }));

  return {
    generated_at: new Date().toISOString(),
    name: cfg.name,
    title: cfg.title,
    refresh_seconds: cfg.refreshSeconds,
    panels: panelsOut,
  };
}
