import * as v from "valibot";
import type { Attempt } from "../session/types";

const fields = {
  id: v.pipe(v.string(), v.uuid()),
  wordId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  typed: v.pipe(v.string(), v.maxLength(1000)),
  latencyMs: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(86_400_000)),
  reviewedAt: v.pipe(v.string(), v.isoTimestamp()),
};

// Preserve the serialized field order: existing idempotency records contain this JSON.
export const AnswerCommand = v.variant("phase", [
  v.strictObject({
    id: fields.id,
    wordId: fields.wordId,
    phase: v.literal("guess"),
    typed: fields.typed,
    rating: v.null(),
    latencyMs: fields.latencyMs,
    reviewedAt: fields.reviewedAt,
    expectedReps: v.literal(0),
  }),
  v.strictObject({
    id: fields.id,
    wordId: fields.wordId,
    phase: v.literal("recall"),
    typed: fields.typed,
    rating: v.picklist([1, 2, 3, 4]),
    latencyMs: fields.latencyMs,
    reviewedAt: fields.reviewedAt,
    expectedReps: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
]);
export type AnswerCommand = v.InferOutput<typeof AnswerCommand>;

/** Reject malformed or oversized text before grading or schedule calculation. */
export function validateAnswerText(typed: unknown): string {
  return v.parse(fields.typed, typed);
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
