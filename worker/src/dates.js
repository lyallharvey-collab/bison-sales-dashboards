/** Date helpers, all UTC-based (Workers have no local timezone; GitHub
 * Actions ran in UTC too, so "today" means the same thing as before). */

export function toUTCDate(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function weekday(date) {
  return date.getUTCDay(); // 0=Sun..6=Sat
}

export function isWeekend(date) {
  const w = weekday(date);
  return w === 0 || w === 6;
}

export function monthBounds(today) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const start = toUTCDate(y, m, 1);
  const end = toUTCDate(y, m + 1, 0); // day 0 of next month = last day of this month
  return [start, end];
}

export function yearBounds(today) {
  const y = today.getUTCFullYear();
  return [toUTCDate(y, 0, 1), toUTCDate(y, 11, 31)];
}

export function businessDaysInRange(start, end) {
  const days = [];
  let d = new Date(start);
  while (d <= end) {
    if (!isWeekend(d)) days.push(new Date(d));
    d = addDays(d, 1);
  }
  return days;
}

/** Roll a weekend date backward to the prior Friday; business days pass
 * through unchanged. Mirrors Python's pd.offsets.BDay().rollback(). */
export function rollBackToBusinessDay(date) {
  let d = new Date(date);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** Monday..Sunday bounds of the ISO week containing `today`. */
export function isoWeekBounds(today) {
  const dow = weekday(today); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0..Sun=6
  const monday = addDays(today, -daysSinceMonday);
  return [monday, addDays(monday, 6)];
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
