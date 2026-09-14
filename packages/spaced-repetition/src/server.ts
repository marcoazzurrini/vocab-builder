import { createEmptyCard } from "ts-fsrs";
import * as v from "valibot";
import { AnswerCommand } from "./lib/commands";
import { reviveFsrsCard } from "./lib/deck";
import { transition } from "./session/transition";

export class RevisionConflict extends Error {
  constructor() {
    super("Progress changed on another device. Reload before answering again.");
  }
}

export type AnswerTransition = {
  correct: boolean;
  previousSchedule: string;
  nextSchedule: string | null;
  revision: number;
};

/** Validate a claimed answer and derive its schedule without exposing scheduler internals. */
export function evaluateAnswer(
  raw: unknown,
  expected: string,
  schedule?: string,
  now = new Date(),
): AnswerTransition {
  const command = v.parse(AnswerCommand, raw);
  const reviewedAt = new Date(command.reviewedAt);
  if (reviewedAt.getTime() > now.getTime() + 5 * 60_000)
    throw new Error("Review time is in the future. Check your device clock.");
  const before =
    schedule === undefined
      ? createEmptyCard(reviewedAt)
      : reviveFsrsCard(JSON.parse(schedule), command.wordId);
  if (
    before.reps !== command.expectedReps ||
    (before.last_review && reviewedAt < before.last_review)
  )
    throw new RevisionConflict();
  const { correct, after } = transition(before, expected, command, reviewedAt);
  return {
    correct,
    previousSchedule: JSON.stringify(before),
    nextSchedule: after ? JSON.stringify(after) : null,
    revision: after?.reps ?? 0,
  };
}
