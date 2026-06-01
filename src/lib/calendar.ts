/**
 * Public-holiday skip logic for the daily reminder job.
 *
 * Two sources are checked, both as `MM-DD` keys (year-agnostic):
 *  - the built-in `DEFAULT_HOLIDAYS` (Vietnamese national holidays)
 *  - an optional `extra` set the caller can inject (for one-off make-up days
 *    or for tests).
 *
 * Weekends (Sat/Sun) are also skipped, even though the cron is `* * 1-5` —
 * makes the function safe to call from one-off manual invocations too.
 */
const DEFAULT_HOLIDAYS = new Set<string>([
  '01-01', // New Year's Day
  '04-30', // Reunification Day
  '05-01', // International Workers' Day
  '09-02', // National Day
]);

function mmdd(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  return `${y}-${mmdd(date)}`;
}

export function isHolidaySkip(date: Date, extra: ReadonlySet<string> = new Set()): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) return true; // Sun=0, Sat=6
  const key = mmdd(date);
  return DEFAULT_HOLIDAYS.has(key) || extra.has(key);
}
