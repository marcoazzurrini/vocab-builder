/**
 * Where a study day begins and ends.
 *
 * Midnight is when learners are awake: a sitting at 23:55 that continues at
 * 00:05 would get a fresh allowance and tomorrow's reviews, doubling the day
 * at exactly the moment doubling it hurts. Anki rolls its day at 4am for the
 * same reason. The hour is a per-user setting; every piece of code that needs
 * to know what "today" means asks these two functions rather than reaching
 * for setHours itself, so the answer cannot drift between the queue, the
 * allowance and the invariants.
 */

/** The moment the current study day began: the last time `rolloverHour` struck. */
export function dayStart(now: Date, rolloverHour: number): Date {
  const start = new Date(now);
  start.setHours(rolloverHour, 0, 0, 0);
  if (start > now) start.setDate(start.getDate() - 1);
  return start;
}

/** The last millisecond of the current study day. */
export function dayEnd(now: Date, rolloverHour: number): Date {
  const end = dayStart(now, rolloverHour);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(-1);
  return end;
}
