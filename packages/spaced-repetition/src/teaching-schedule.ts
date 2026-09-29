import { createEmptyCard } from "ts-fsrs";

/** First retrieval is never offered before sixty seconds after teaching. */
export const initialRecallAt = (reviewedAt: string): string =>
  new Date(new Date(reviewedAt).getTime() + 60_000).toISOString();

/** Teaching seeds a due date, not a rating or a review history entry. */
export const teachingSchedule = (initialRecallTime: string): string => {
  const due = new Date(initialRecallTime);
  if (!Number.isFinite(due.getTime())) {
    throw new TypeError("Invalid initial recall time.");
  }
  return JSON.stringify(createEmptyCard(due));
};
