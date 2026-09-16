import { fsrs, State } from "ts-fsrs";
import type { Card as FsrsCard, FSRS } from "ts-fsrs";
import * as v from "valibot";

import type { AnswerCommand } from "./answer-command";
import { effortsFor } from "./answer-grading";
import { matches } from "./answer-matching";

/**
 * A word's scheduling state. Unrated cards are reconstructed from introductions;
 * rated cards carry persisted FSRS schedules. A word not yet introduced has no card.
 */
export interface Card {
  wordId: string;
  fsrs: FsrsCard;
}

/** A date as JSON returns it: an ISO string, or a Date if it never left. */
const StoredDate = v.pipe(
  v.union([v.string(), v.date()]),
  v.transform((value) => new Date(value)),
  v.check((date) => !Number.isNaN(date.getTime()), "unparseable date")
);

/**
 * Validate persisted schedules and revive dates before FSRS does arithmetic.
 * A string-valued due date can silently produce the wrong schedule.
 *
 * Older schedules predate learning_steps and default to step zero. Unknown
 * fields survive decoding so an upstream FSRS addition is not silently lost.
 */
const FsrsState = v.looseObject({
  difficulty: v.number(),
  due: StoredDate,
  elapsed_days: v.number(),
  lapses: v.pipe(v.number(), v.integer(), v.minValue(0)),
  last_review: v.optional(StoredDate),
  learning_steps: v.optional(v.number(), 0),
  reps: v.pipe(v.number(), v.integer(), v.minValue(0)),
  scheduled_days: v.number(),
  stability: v.number(),
  state: v.picklist([
    State.New,
    State.Learning,
    State.Review,
    State.Relearning,
  ]),
});

/**
 * Rebuild the Date objects JSON threw away, refusing anything else.
 *
 * Loud rather than lenient: a card is a derived cache and can be rebuilt from
 * `attempts`, so unreadable scheduling state is a repairable problem — but only
 * if someone is told about it. Skipping the row instead would make the word look
 * uncarded, and re-introducing it would collide with the card already there.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This public storage boundary validates untrusted schedules with FsrsState.
export const reviveFsrsCard = (raw: unknown, cardId?: string): FsrsCard => {
  const result = v.safeParse(FsrsState, raw);
  if (!result.success) {
    const where = cardId ? ` for card ${cardId}` : "";
    throw new Error(
      `Unreadable scheduling state${where}: ${v.summarize(result.issues)}`
    );
  }
  return result.output;
};

// oxlint-disable-next-line unicorn/custom-error-definition -- Preserve the public constructor name and inherited Error.name contract.
export class RevisionConflict extends Error {
  // oxlint-disable-next-line unicorn/custom-error-definition -- Existing callers receive Error.name, not a renamed error category.
  constructor() {
    super("Progress changed on another device. Reload before answering again.");
  }
}

/** One scheduler policy for optimistic sessions and authoritative evaluation. */
export const createScheduler = (): FSRS => fsrs({ enable_short_term: true });

/** The single grading and scheduling transition used by optimistic sessions and persistence. */
export const transition = (
  before: FsrsCard,
  expected: string,
  answer: Pick<AnswerCommand, "typed" | "phase" | "rating">,
  reviewedAt: Date,
  scheduler: FSRS = createScheduler()
) => {
  if (before.last_review && reviewedAt < before.last_review) {
    throw new RevisionConflict();
  }
  const correct = matches(answer.typed, expected);
  if (answer.phase === "guess") {
    if (answer.rating !== null || before.reps !== 0) {
      throw new Error("Guesses cannot be rated.");
    }
    return { after: null, correct };
  }
  if (answer.rating === null || correct !== (answer.rating !== 1)) {
    throw new Error("Rating does not match the answer.");
  }
  if (answer.rating === 4 && !effortsFor(before).includes("easy")) {
    throw new Error("Easy is unavailable for a first recall.");
  }
  return {
    after: scheduler.next(before, reviewedAt, answer.rating).card,
    correct,
  };
};
