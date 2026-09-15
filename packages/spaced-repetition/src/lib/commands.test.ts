import { describe, expect, it } from "bun:test";
import { createEmptyCard, fsrs, Rating } from "ts-fsrs";
import * as v from "valibot";
import { AnswerCommand, commandFor } from "./commands";
import type { Attempt } from "../session/types";

const NOW = new Date("2026-08-10T09:00:00.123Z");
const ID = "e581fc23-29bd-48a2-a842-071f9eb9f406";
const valid = {
  id: ID,
  wordId: "chien",
  phase: "recall",
  typed: "chien",
  rating: 3,
  latencyMs: 1200,
  reviewedAt: NOW.toISOString(),
  expectedReps: 2,
};

const boundaries: { field: string; accepted: unknown[]; rejected: unknown[] }[] = [
  {
    field: "id",
    accepted: [ID, "550e8400-e29b-41d4-a716-446655440000"],
    rejected: ["", "constant", "e581fc2329bd48a2a842071f9eb9f406", `${ID}x`, null, 1],
  },
  { field: "wordId", accepted: ["w", "w".repeat(128)], rejected: ["", "w".repeat(129), null, 1] },
  { field: "typed", accepted: ["", "x".repeat(1000)], rejected: ["x".repeat(1001), null, 1] },
  {
    field: "latencyMs",
    accepted: [0, 1, 86_400_000],
    rejected: [-1, 0.5, 86_400_001, NaN, Infinity, -Infinity, "1", null],
  },
  {
    field: "reviewedAt",
    accepted: [NOW.toISOString(), "2026-08-10T09:00:00Z", "2026-08-10T11:00:00+02:00"],
    rejected: [
      "",
      "yesterday",
      "2026-08-10",
      "2026-08-10T09:00:00",
      "2026-13-10T09:00:00Z",
      NOW,
      null,
      1,
    ],
  },
  {
    field: "expectedReps",
    accepted: [0, 1, 42],
    rejected: [-1, 0.5, NaN, Infinity, -Infinity, "0", null],
  },
  { field: "rating", accepted: [1, 2, 3, 4], rejected: [0, 5, 2.5, "3", null, NaN] },
];

describe("answer command validation", () => {
  for (const { field, accepted, rejected } of boundaries) {
    for (const value of accepted) {
      it(`accepts ${field} boundary ${String(value).slice(0, 60)}`, () => {
        const input = { ...valid, [field]: value };
        expect<unknown>(v.parse(AnswerCommand, input)).toEqual(input);
      });
    }
    for (const value of rejected) {
      it(`rejects ${field} boundary ${String(value).slice(0, 60)}`, () => {
        expect(v.safeParse(AnswerCommand, { ...valid, [field]: value }).success).toBe(false);
      });
    }
  }

  for (const phase of ["guess", "recall"] as const) {
    const input = phase === "guess" ? { ...valid, phase, rating: null, expectedReps: 0 } : valid;
    for (const field of Object.keys(valid)) {
      it(`requires ${field} for ${phase}`, () => {
        const missing: Record<string, unknown> = { ...input };
        delete missing[field];
        expect(v.safeParse(AnswerCommand, missing).success).toBe(false);
      });
    }
    for (const extra of ["correct", "stateBefore", "unexpected"]) {
      it(`rejects unknown ${extra} key for ${phase}`, () => {
        expect(v.safeParse(AnswerCommand, { ...input, [extra]: true }).success).toBe(false);
      });
    }
    // Both variant branches must retain the same field validators.
    for (const { field, rejected } of boundaries.filter(
      ({ field }) => !["rating", "expectedReps"].includes(field),
    )) {
      it(`rejects all invalid ${field} values for ${phase}`, () => {
        for (const value of rejected) {
          expect(v.safeParse(AnswerCommand, { ...input, [field]: value }).success).toBe(false);
        }
      });
    }
  }

  it("accepts only an unrated revision-zero guess", () => {
    const guess = { ...valid, phase: "guess", rating: null, expectedReps: 0 };
    expect<unknown>(v.parse(AnswerCommand, guess)).toEqual(guess);
    for (const rating of [0, 1, 2, 3, 4, "3", undefined]) {
      expect(v.safeParse(AnswerCommand, { ...guess, rating }).success).toBe(false);
    }
    for (const expectedReps of [-1, 0.5, 1, 2, "0", null]) {
      expect(v.safeParse(AnswerCommand, { ...guess, expectedReps }).success).toBe(false);
    }
  });

  for (const phase of ["exposure", "feedback", "", null, 0]) {
    it(`rejects unknown phase ${phase}`, () => {
      expect(v.safeParse(AnswerCommand, { ...valid, phase }).success).toBe(false);
    });
  }

  for (const phase of ["guess", "recall"] as const) {
    it(`preserves persisted JSON field order for ${phase} regardless of input order`, () => {
      const parsed = v.parse(AnswerCommand, {
        expectedReps: phase === "guess" ? 0 : 2,
        reviewedAt: NOW.toISOString(),
        latencyMs: 1200,
        rating: phase === "guess" ? null : 3,
        typed: "chien",
        phase,
        wordId: "chien",
        id: ID,
      });
      expect(JSON.stringify(parsed)).toBe(
        `{"id":"${ID}","wordId":"chien","phase":"${phase}","typed":"chien","rating":${phase === "guess" ? "null" : "3"},"latencyMs":1200,"reviewedAt":"2026-08-10T09:00:00.123Z","expectedReps":${phase === "guess" ? 0 : 2}}`,
      );
    });
  }
});

function attempt(): Attempt {
  const scheduler = fsrs({ enable_short_term: true });
  const firstAt = new Date("2026-08-01T09:00:00Z");
  const first = scheduler.next(createEmptyCard(firstAt), firstAt, Rating.Good).card;
  const stateBefore = scheduler.next(first, new Date("2026-08-02T09:00:00Z"), Rating.Good).card;
  return {
    wordId: "chien",
    phase: "recall",
    typed: " CHIEN ",
    correct: true,
    rating: Rating.Hard,
    latencyMs: 1234,
    stateBefore,
    reviewedAt: NOW,
  };
}

describe("commandFor", () => {
  it("copies the actual previous revision, text, rating, latency and timestamp without mutating the attempt", () => {
    const input = attempt();
    const original = JSON.stringify(input);
    expect(input.stateBefore.reps).toBe(2);
    const command = commandFor(input);
    expect(command).toEqual({
      id: command.id,
      wordId: "chien",
      phase: "recall",
      typed: " CHIEN ",
      rating: 2,
      latencyMs: 1234,
      reviewedAt: "2026-08-10T09:00:00.123Z",
      expectedReps: 2,
    });
    expect(JSON.stringify(input)).toBe(original);
    expect(Object.keys(command)).toEqual([
      "id",
      "wordId",
      "phase",
      "typed",
      "rating",
      "latencyMs",
      "reviewedAt",
      "expectedReps",
    ]);
    expect(JSON.stringify(command)).toBe(
      `{"id":"${command.id}","wordId":"chien","phase":"recall","typed":" CHIEN ","rating":2,"latencyMs":1234,"reviewedAt":"2026-08-10T09:00:00.123Z","expectedReps":2}`,
    );
  });

  it("mints a distinct valid UUID for every command, even from the same attempt", () => {
    const input = attempt();
    const ids = Array.from({ length: 32 }, () => commandFor(input).id);
    expect(new Set(ids).size).toBe(32);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
  });

  it("serializes a guess with null rating and no previous ratings", () => {
    const input: Attempt = {
      ...attempt(),
      phase: "guess",
      rating: null,
      stateBefore: createEmptyCard(NOW),
    };
    const command = commandFor(input);
    expect(command.phase).toBe("guess");
    expect(command.rating).toBeNull();
    expect(command.expectedReps).toBe(0);
    expect(JSON.stringify(command)).toBe(
      `{"id":"${command.id}","wordId":"chien","phase":"guess","typed":" CHIEN ","rating":null,"latencyMs":1234,"reviewedAt":"2026-08-10T09:00:00.123Z","expectedReps":0}`,
    );
  });

  it("refuses invalid attempts instead of emitting invalid commands", () => {
    expect(() => commandFor({ ...attempt(), latencyMs: -1 })).toThrow();
    expect(() => commandFor({ ...attempt(), phase: "guess", rating: Rating.Good })).toThrow();
    expect(() => commandFor({ ...attempt(), phase: "guess", rating: null })).toThrow();
    expect(() => commandFor({ ...attempt(), reviewedAt: new Date(NaN) })).toThrow();
  });
});
