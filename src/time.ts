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

/**
 * Epoch ms of the midnight at which a badge for a window of `days` days,
 * computed at `computedAt`, has fully rolled over: the first moment
 * `calendarDaysBetween(computedAt, then)` reaches `days`. This is the
 * deadline a published usage figure turns stale at, even when nothing
 * writes again to re-render it.
 */
export function badgeExpiryMs(computedAt: number, days: number): number {
  return startOfLocalDayMs(computedAt) + days * DAY_MS;
}
