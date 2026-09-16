import { createEmptyCard } from "ts-fsrs";
import * as v from "valibot";

import { AnswerCommand } from "./answer-command";
import {
  reviveFsrsCard,
  transition,
  RevisionConflict,
} from "./review-scheduling";

export { RevisionConflict } from "./review-scheduling";

export interface AnswerTransition {
  correct: boolean;
  previousSchedule: string;
  nextSchedule: string | null;
  revision: number;
}

/** Validate a claimed answer and derive its schedule without exposing scheduler internals. */
export const evaluateAnswer = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This public I/O boundary validates untrusted commands before grading or scheduling.
  raw: unknown,
  expected: string,
  schedule?: string,
  now = new Date()
): AnswerTransition => {
  const command = v.parse(AnswerCommand, raw);
  if (!Number.isFinite(now.getTime())) {
    // oxlint-disable-next-line unicorn/prefer-type-error -- Preserve the public Error category for invalid server clocks.
    throw new Error("The server clock returned an invalid date.");
  }
  const reviewedAt = new Date(command.reviewedAt);
  if (reviewedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("Review time is in the future. Check your device clock.");
  }
  const before =
    schedule === undefined
      ? createEmptyCard(reviewedAt)
      : reviveFsrsCard(JSON.parse(schedule), command.wordId);
  if (before.reps !== command.expectedReps) {
    throw new RevisionConflict();
  }
  const { correct, after } = transition(before, expected, command, reviewedAt);
  return {
    correct,
    nextSchedule: after ? JSON.stringify(after) : null,
    previousSchedule: JSON.stringify(before),
    revision: after?.reps ?? 0,
  };
};
