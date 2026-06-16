export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Epoch ms of the most recent local midnight at or before `now`. Uses the host
 * timezone (where the CLI runs), so "today" tracks the user's wall clock rather
 * than UTC or a rolling 24h offset.
 */
export function startOfLocalDayMs(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Number of local calendar-day boundaries crossed between `from` and `to`
 * (0 when both fall on the same local day, 1 once a single midnight has passed).
 */
export function calendarDaysBetween(from: number, to: number): number {
  return Math.round((startOfLocalDayMs(to) - startOfLocalDayMs(from)) / DAY_MS);
}
