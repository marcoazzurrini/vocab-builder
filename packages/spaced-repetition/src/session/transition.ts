import { fsrs } from "ts-fsrs";
import type { Card, FSRS } from "ts-fsrs";
import { effortsFor } from "./grading";
import { matches } from "./matching";
import type { AnswerCommand } from "../lib/commands";

export class RevisionConflict extends Error {
  constructor() {
    super("Progress changed on another device. Reload before answering again.");
  }
}

/** The single grading and scheduling transition used by optimistic sessions and persistence. */
export function transition(
  before: Card,
  expected: string,
  answer: Pick<AnswerCommand, "typed" | "phase" | "rating">,
  reviewedAt: Date,
  scheduler: FSRS = fsrs({ enable_short_term: true }),
) {
  if (before.last_review && reviewedAt < before.last_review) throw new RevisionConflict();
  const correct = matches(answer.typed, expected);
  if (answer.phase === "guess") {
    if (answer.rating !== null || before.reps !== 0) throw new Error("Guesses cannot be rated.");
    return { correct, after: null };
  }
  if (answer.rating === null || correct !== (answer.rating !== 1))
    throw new Error("Rating does not match the answer.");
  if (answer.rating === 4 && !effortsFor(before).includes("easy"))
    throw new Error("Easy is unavailable for a first recall.");
  return { correct, after: scheduler.next(before, reviewedAt, answer.rating).card };
}
