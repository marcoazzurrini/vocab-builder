/**
 * Where a study day begins and ends.
 *
 * Midnight is when learners are awake: a sitting at 23:55 that continues at
 * 00:05 would get a fresh allowance and tomorrow's reviews, doubling the day
 * at exactly the moment doubling it hurts. Anki rolls its day at 4am for the
 * same reason. The hour is a per-user setting; every piece of code that needs
 * to know what "today" means asks these functions rather than reaching
 * for setHours itself, so the runtime queue and allowance use one definition.
 * Tests use independently specified calendar boundaries.
 */

/**
 * The current device-local study day, as the half-open interval [start, nextStart).
 * Each boundary uses its own calendar date, not a fixed 24-hour duration or the
 * previous boundary's possibly shifted hour. Native Date compatibility rules
 * apply: an ambiguous time uses the earlier occurrence; a nonexistent time
 * shifts forward by the gap. Invalid dates and hours that are not integers in
 * 0–23 throw RangeError, as do boundaries outside Date's representable range.
 */
interface StudyDay {
  start: Date;
  nextStart: Date;
}

export const studyDay = (now: Date, rolloverHour: number): StudyDay => {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("Invalid study day date");
  }
  if (
    !Number.isInteger(rolloverHour) ||
    rolloverHour < 0 ||
    rolloverHour > 23
  ) {
    throw new RangeError("Rollover hour must be an integer from 0 to 23");
  }

  const boundary = (dayOffset: number): Date => {
    // Normalize the calendar label without a timezone, then resolve the complete
    // local date/time at once. Transplanting a date onto the epoch's local hour
    // can cross an unrelated DST gap before setHours gets to apply our rollover.
    const label = new Date(0);
    label.setUTCFullYear(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + dayOffset
    );
    if (!Number.isFinite(label.getTime())) {
      throw new RangeError("Study day boundary is out of range");
    }
    // ISO local parsing also preserves years 0–99 (the numeric constructor does not).
    const date = new Date(
      `${label.toISOString().split("T")[0]}T${String(rolloverHour).padStart(2, "0")}:00:00.000`
    );
    if (!Number.isFinite(date.getTime())) {
      throw new RangeError("Study day boundary is out of range");
    }
    return date;
  };

  let dayOffset = 0;
  let start = boundary(dayOffset);
  // A timezone change can skip an entire civil date (for example Apia in
  // December 2011). Find actual enclosing instants, not merely yesterday's label.
  while (start > now) {
    dayOffset -= 1;
    start = boundary(dayOffset);
  }
  let nextStart = boundary(dayOffset + 1);
  while (nextStart <= now) {
    start = nextStart;
    dayOffset += 1;
    nextStart = boundary(dayOffset + 1);
  }
  return { nextStart, start };
};

/** The moment the current study day began: the last rollover boundary. */
export const dayStart = (now: Date, rolloverHour: number): Date =>
  studyDay(now, rolloverHour).start;

/** The last millisecond of the current study day (inclusive compatibility API). */
export const dayEnd = (now: Date, rolloverHour: number): Date =>
  new Date(studyDay(now, rolloverHour).nextStart.getTime() - 1);
