import type { Card as FsrsCard, Grade } from "ts-fsrs";
import * as v from "valibot";

/** Internal answer facts used to construct a durable command; storage is external. */
export interface Attempt {
  /** Attempts are keyed by what they are about, not by the cache row. */
  wordId: string;
  phase: "guess" | "recall";
  typed: string;
  correct: boolean;
  /** Null for guesses: a pretest is logged but never rated. */
  rating: Grade | null;
  latencyMs: number;
  /** The card's FSRS state *before* this attempt, so history can be replayed. */
  stateBefore: FsrsCard;
  reviewedAt: Date;
}

const fields = {
  id: v.pipe(v.string(), v.uuid()),
  latencyMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(86_400_000)
  ),
  reviewedAt: v.pipe(v.string(), v.isoTimestamp()),
  typed: v.pipe(v.string(), v.maxLength(1000)),
  wordId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
};

// Preserve the serialized field order: existing idempotency records contain this JSON.
// oxlint-disable-next-line eslint/no-redeclare -- The public schema and inferred type intentionally share one export.
export const AnswerCommand = v.variant("phase", [
  // oxlint-disable-next-line eslint/sort-keys -- Valibot emits this persisted JSON order; sorting breaks idempotency comparisons.
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
  // oxlint-disable-next-line eslint/sort-keys -- Valibot emits this persisted JSON order; sorting breaks idempotency comparisons.
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
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This public boundary parses untrusted text with its owning schema.
export const validateAnswerText = (typed: unknown): string =>
  v.parse(fields.typed, typed);

export const commandFor = (attempt: Attempt): AnswerCommand =>
  v.parse(AnswerCommand, {
    expectedReps: attempt.stateBefore.reps,
    id: crypto.randomUUID(),
    latencyMs: attempt.latencyMs,
    phase: attempt.phase,
    rating: attempt.rating,
    reviewedAt: attempt.reviewedAt.toISOString(),
    typed: attempt.typed,
    wordId: attempt.wordId,
  });
