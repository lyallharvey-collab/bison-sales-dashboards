import { isoDate, isWeekend, rollBackToBusinessDay } from './dates.js';

/** Sum `measure` per calendar day of `dateField`, for dateField in
 * [dayFrom, dayTo] inclusive, aggregated server-side via read_group.
 * Returns Map<isoDateString, number>. */
export async function readGroupDaily(client, model, domain, dateField, measure, dayFrom, dayTo) {
  const fullDomain = [
    ...domain,
    [dateField, '>=', isoDate(dayFrom)],
    [dateField, '<=', isoDate(dayTo)],
  ];
  const groups = await client.readGroup(model, fullDomain, [measure], [`${dateField}:day`], false);
  const out = new Map();
  for (const g of groups) {
    const rng = g.__range && g.__range[`${dateField}:day`];
    if (!rng || !rng.from) continue;
    out.set(String(rng.from).slice(0, 10), g[measure] || 0);
  }
  return out;
}

/** Same as readGroupDaily but at month granularity — Map<isoDateString (first
 * of month), number>. */
export async function readGroupMonthly(client, model, domain, dateField, measure, monthFrom, monthTo) {
  const fullDomain = [
    ...domain,
    [dateField, '>=', isoDate(monthFrom)],
    [dateField, '<=', isoDate(monthTo)],
  ];
  const groups = await client.readGroup(model, fullDomain, [measure], [`${dateField}:month`], false);
  const out = new Map();
  for (const g of groups) {
    const rng = g.__range && g.__range[`${dateField}:month`];
    if (!rng || !rng.from) continue;
    out.set(String(rng.from).slice(0, 10), g[measure] || 0);
  }
  return out;
}

/** A single server-side sum, no groupby — for one-off scalars. */
export async function readGroupTotal(client, model, domain, measure) {
  const groups = await client.readGroup(model, domain, [measure], [], false);
  if (!groups.length) return 0;
  return groups[0][measure] || 0;
}

export function addMaps(a, b) {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) || 0) + v);
  return out;
}

/** The chart's x-axis is business days only. Weekend activity has no day of
 * its own to land on, so fold it backward into the same week's Friday —
 * shows up immediately rather than sitting invisible until Monday arrives,
 * including when "today" is itself a Saturday/Sunday. Mirrors
 * build.py's _fold_weekends_into_prior_business_day exactly. */
export function foldWeekendsIntoPriorBusinessDay(dailyMap) {
  const out = new Map();
  for (const [isoDay, val] of dailyMap) {
    const d = new Date(isoDay + 'T00:00:00Z');
    const target = isWeekend(d) ? rollBackToBusinessDay(d) : d;
    const key = isoDate(target);
    out.set(key, (out.get(key) || 0) + val);
  }
  return out;
}

/** Cumulative sum over an ordered list of Date "buckets" (business days or
 * months), filling any bucket absent from `dailyMap` with 0 — matches
 * pandas' reindex(fill_value=0.0).cumsum(). */
export function cumulativeOverBuckets(dailyMap, buckets) {
  let running = 0;
  const out = new Map();
  for (const b of buckets) {
    const key = isoDate(b);
    running += dailyMap.get(key) || 0;
    out.set(key, running);
  }
  return out;
}
