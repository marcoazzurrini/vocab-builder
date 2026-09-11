import * as v from "valibot";
import type { Attempt } from "../session/types";

export const AnswerCommand = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  wordId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  phase: v.picklist(["guess", "recall"]),
  typed: v.pipe(v.string(), v.maxLength(1000)),
  rating: v.nullable(v.picklist([1, 2, 3, 4])),
  latencyMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400_000)),
  reviewedAt: v.pipe(v.string(), v.isoTimestamp()),
  expectedReps: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export type AnswerCommand = v.InferOutput<typeof AnswerCommand>;

export class SyncConflict extends Error {
  constructor() {
    super(
      "I progressi sono cambiati su un altro dispositivo. Le risposte in attesa non sono state salvate.",
    );
  }
}

export function commandFor(attempt: Attempt): AnswerCommand {
  return v.parse(AnswerCommand, {
    id: crypto.randomUUID(),
    wordId: attempt.wordId,
    phase: attempt.phase,
    typed: attempt.typed,
    rating: attempt.rating,
    latencyMs: attempt.latencyMs,
    reviewedAt: attempt.reviewedAt.toISOString(),
    expectedReps: attempt.stateBefore.reps,
  });
}
