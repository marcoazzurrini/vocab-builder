import { createEmptyCard } from "ts-fsrs";
import * as v from "valibot";
import { AnswerCommand } from "./lib/commands";
import { reviveFsrsCard } from "./lib/deck";
import { transition, RevisionConflict } from "./session/transition";
export { RevisionConflict } from "./session/transition";

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
  if (!Number.isFinite(now.getTime()))
    throw new Error("The server clock returned an invalid date.");
  const reviewedAt = new Date(command.reviewedAt);
  if (reviewedAt.getTime() > now.getTime() + 5 * 60_000)
    throw new Error("Review time is in the future. Check your device clock.");
  const before =
    schedule === undefined
      ? createEmptyCard(reviewedAt)
      : reviveFsrsCard(JSON.parse(schedule), command.wordId);
  if (before.reps !== command.expectedReps) throw new RevisionConflict();
  const { correct, after } = transition(before, expected, command, reviewedAt);
  return {
    correct,
    previousSchedule: JSON.stringify(before),
    nextSchedule: after ? JSON.stringify(after) : null,
    revision: after?.reps ?? 0,
  };
}
