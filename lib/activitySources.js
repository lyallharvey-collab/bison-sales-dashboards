/**
 * Completed sales activities per rep, scored in points — the data behind the
 * /activities/ page's split bars.
 *
 * Brings back the per-rep activity tracker Simon kept in Excel until Odoo went
 * live (Dec 2023). The scoring is Lyall's rule, and it is the same one used to
 * backfill that spreadsheet from Odoo (../activity-tracker/), so the page and
 * the sheet agree on what a point is:
 *
 *   call, in or out, contacted or not   1
 *   visit (Appointment / Site Demo):    1 if not contacted, 5 if contacted
 *   showroom visit                      5
 *
 * "Contacted" is the Contacted Call tick on the activity (mail.message
 * `contacted_call`). Reps took it up at different times — Simon from about
 * April 2024, Braden and Angus from January 2025, Roddy almost never — and a
 * visit logged without the tick scores 1. That was decided, not overlooked:
 * do not re-score those as 5.
 *
 * Where the numbers come from: marking an activity done in Odoo deletes the
 * mail.activity and leaves a chatter message carrying `mail_activity_type_id`
 * and `contacted_call`, authored by whoever marked it done. So this counts
 * mail.message, grouped by author, type and the tick — one small read_group
 * per period, never a row fetch.
 *
 * Mirrored in dashboards/activity_sources.py; `npm run livetest` diffs the two.
 */

import { addDays, isoDate, isoWeekBounds, monthBounds, toUTCDate } from './dates.js';

/**
 * Who is on the board, by the res.partner id Odoo puts on their messages (the
 * `author_id` of a done-activity message is the user's partner, not the user).
 * Verified against live Odoo on 18 Nov 2026. The first four are the A/B/R/S
 * columns of the old spreadsheet; Billy and Laurie were added for this page.
 * Jonathan Robins (the old J column) is deliberately left off for now.
 */
export const REPS = [
  { key: 'angus', name: 'Angus Bushnell', partnerId: 132062 },
  { key: 'braden', name: 'Braden Carvell', partnerId: 132063 },
  { key: 'roddy', name: 'Roddy Bushnell', partnerId: 132068 },
  { key: 'simon', name: 'Simon Harvey', partnerId: 132070 },
  { key: 'billy', name: 'Billy Hodgkinson', partnerId: 134942 },
  { key: 'laurie', name: 'Laurie Jackson', partnerId: 132751 },
];

/** mail.activity.type ids. Online Meeting (34), Email (1) and Action (4) are
 * deliberately not counted — the old tracker didn't count them either. */
export const ACTIVITY_TYPES = {
  callOut: 17,      // Phone Call Out
  callIn: 2,        // Phone Call In
  appointment: 3,   // Appointment
  siteDemo: 32,     // Site Demo (Translas) — a site visit
  showroom: 18,     // Showroom Visit
};

/**
 * The bar segments, in the order they are drawn. Colour follows the category:
 * calls are blues, visits are oranges (dark = the 5-point kind), showroom is
 * teal. Purple (Target) and the status green/red are reserved elsewhere in this
 * project and never used here. Dark fills carry white labels and light fills a
 * dark ink of the same hue, each at least 4.5:1.
 */
export const CATEGORIES = [
  { key: 'calls_out', label: 'Calls out', points: 1, color: '#2f5d8a', ink: '#ffffff' },
  { key: 'calls_in', label: 'Calls in', points: 1, color: '#9cbbdc', ink: '#14304d' },
  { key: 'visits_contacted', label: 'Visits, contacted', points: 5, color: '#a6520b', ink: '#ffffff' },
  { key: 'visits_not_contacted', label: 'Visits, not contacted', points: 1, color: '#f2c38f', ink: '#5a2e05' },
  { key: 'showroom', label: 'Showroom', points: 5, color: '#1f7a70', ink: '#ffffff' },
];

export const PERIODS = [
  { key: 'week', label: 'This week' },
  { key: 'last_week', label: 'Last week' },
  { key: 'month', label: 'This month' },
  { key: 'ytd', label: 'Year to date' },
];

/** Which category a done-activity message falls in, or null if not counted. */
export function categoryOf(typeId, contacted) {
  const T = ACTIVITY_TYPES;
  if (typeId === T.callOut) return 'calls_out';
  if (typeId === T.callIn) return 'calls_in';
  if (typeId === T.appointment || typeId === T.siteDemo) {
    return contacted ? 'visits_contacted' : 'visits_not_contacted';
  }
  if (typeId === T.showroom) return 'showroom';
  return null;
}

/**
 * Inclusive date bounds of each period, by UTC calendar date like everything
 * else in this project. "Last week" is the whole previous Monday–Sunday; the
 * others run to today.
 *
 * During British Summer Time a UK day starts at 23:00 UTC the day before, so an
 * activity marked done between 23:00 and midnight on a Sunday lands in the
 * following week here. Nobody is logging calls then; the spreadsheet backfill
 * used UK time and agrees in practice.
 */
export function periodBounds(key, today) {
  const [monday] = isoWeekBounds(today);
  if (key === 'week') return [monday, today];
  if (key === 'last_week') return [addDays(monday, -7), addDays(monday, -1)];
  if (key === 'month') return [monthBounds(today)[0], today];
  if (key === 'ytd') return [toUTCDate(today.getUTCFullYear(), 0, 1), today];
  throw new Error(`unknown activity period '${key}'`);
}

/** mail.message.date is a datetime in UTC, so bound it by datetime strings:
 * from midnight on the first day up to (not including) midnight after the last. */
export function periodDomain(from, to) {
  return [
    ['mail_activity_type_id', 'in', Object.values(ACTIVITY_TYPES)],
    ['author_id', 'in', REPS.map((r) => r.partnerId)],
    ['date', '>=', `${isoDate(from)} 00:00:00`],
    ['date', '<', `${isoDate(addDays(to, 1))} 00:00:00`],
  ];
}

const m2oId = (v) => (Array.isArray(v) ? v[0] : (v || null));

/**
 * Pure assembly from read_group rows — separated out so the scoring can be
 * unit-tested without Odoo (lib/activity.test.mjs).
 *
 * Rows always come back for every rep in REPS order, zeros included, so a rep
 * with a quiet week still appears on the board rather than silently vanishing.
 * Sorting by points is the renderer's job.
 */
export function assembleActivity(groups) {
  const byPartner = new Map(REPS.map((r) => [r.partnerId, r]));
  const counts = new Map(REPS.map((r) => [r.key, Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]))]));
  for (const g of groups) {
    const rep = byPartner.get(m2oId(g.author_id));
    const cat = categoryOf(m2oId(g.mail_activity_type_id), !!g.contacted_call);
    if (!rep || !cat) continue;
    counts.get(rep.key)[cat] += g.__count || 0;
  }
  const pointsOf = (c) => CATEGORIES.reduce((s, k) => s + c[k.key] * k.points, 0);
  const activitiesOf = (c) => CATEGORIES.reduce((s, k) => s + c[k.key], 0);

  const reps = REPS.map((r) => {
    const c = counts.get(r.key);
    return { key: r.key, name: r.name, counts: c, points: pointsOf(c), activities: activitiesOf(c) };
  });
  const totals = Object.fromEntries(CATEGORIES.map((k) => [k.key, reps.reduce((s, r) => s + r.counts[k.key], 0)]));
  return { reps, totals, points: pointsOf(totals), activities: activitiesOf(totals) };
}

export async function activityForPeriod(client, key, today) {
  const [from, to] = periodBounds(key, today);
  const groups = await client.readGroup(
    'mail.message', periodDomain(from, to), [],
    ['author_id', 'mail_activity_type_id', 'contacted_call'], false,
  );
  const label = PERIODS.find((p) => p.key === key).label;
  return { key, label, from: isoDate(from), to: isoDate(to), ...assembleActivity(groups) };
}

/** Every period in one payload, so switching between them on the desktop costs
 * no request — the same principle as the chart views in static/views.js. Four
 * small read_groups, issued concurrently. */
export async function repActivity(client, today) {
  return Promise.all(PERIODS.map((p) => activityForPeriod(client, p.key, today)));
}
