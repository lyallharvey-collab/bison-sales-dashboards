import { isoDate, isWeekend, rollBackToBusinessDay, rollForwardToBusinessDay } from './dates.js';

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

/** SEVERAL server-side sums in ONE call, no groupby. Returns
 * Record<measure, number>.
 *
 * Deliberately not a loop over readGroupTotal: CPU is charged per response
 * parsed, and N measures off one model with one domain is one response. See
 * the 10ms-ceiling note in README. */
export async function readGroupTotals(client, model, domain, measures) {
  const groups = await client.readGroup(model, domain, measures, [], false);
  const out = {};
  for (const m of measures) out[m] = (groups.length && groups[0][m]) || 0;
  return out;
}

/** Sum `measure` per sales team (`team_id`), for dateField in
 * [dayFrom, dayTo] inclusive. Returns Map<teamId, number>.
 *
 * Records with no team land under key 0 rather than being dropped — a
 * division scoreboard whose parts don't add up to the whole is worse than
 * one that shows an unattributed remainder. */
export async function readGroupByTeam(client, model, domain, dateField, measure, dayFrom, dayTo) {
  const fullDomain = [
    ...domain,
    [dateField, '>=', isoDate(dayFrom)],
    [dateField, '<=', isoDate(dayTo)],
  ];
  const groups = await client.readGroup(model, fullDomain, [measure], ['team_id'], false);
  const out = new Map();
  for (const g of groups) {
    // read_group returns a many2one as [id, display_name], or false when unset.
    const id = Array.isArray(g.team_id) ? g.team_id[0] : 0;
    out.set(id, (out.get(id) || 0) + (g[measure] || 0));
  }
  return out;
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
export function foldWeekendsIntoPriorBusinessDay(dailyMap, floorDate) {
  // A weekend at the very START of the month rolls back into the previous
  // month, which isn't on this chart's axis — so the value used to vanish
  // silently. August 2026 is a live example: it opens on a Saturday, and the
  // service-contract invoices are dated the 1st. In that case roll FORWARD to
  // the first business day instead, so the money stays in the month it belongs
  // to. Losing it is never the right answer.
  const floor = floorDate ? isoDate(floorDate) : null;
  const out = new Map();
  for (const [isoDay, val] of dailyMap) {
    const d = new Date(isoDay + 'T00:00:00Z');
    let target = d;
    if (isWeekend(d)) {
      target = rollBackToBusinessDay(d);
      if (floor && isoDate(target) < floor) target = rollForwardToBusinessDay(d);
    }
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
