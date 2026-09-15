import { describe, expect, it } from "bun:test";

import { createEmptyCard, fsrs, Rating } from "ts-fsrs";
import * as v from "valibot";

import type { Attempt } from "../session/types";
import { AnswerCommand, commandFor } from "./commands";

const NOW = new Date("2026-08-10T09:00:00.123Z");
const ID = "e581fc23-29bd-48a2-a842-071f9eb9f406";
const valid = {
  expectedReps: 2,
  id: ID,
  latencyMs: 1200,
  phase: "recall",
  rating: 3,
  reviewedAt: NOW.toISOString(),
  typed: "chien",
  wordId: "chien",
};

const boundaries: {
  field: string;
  accepted: unknown[];
  rejected: unknown[];
}[] = [
  {
    accepted: [ID, "550e8400-e29b-41d4-a716-446655440000"],
    field: "id",
    rejected: [
      "",
      "constant",
      "e581fc2329bd48a2a842071f9eb9f406",
      `${ID}x`,
      null,
      1,
    ],
  },
  {
    accepted: ["w", "w".repeat(128)],
    field: "wordId",
    rejected: ["", "w".repeat(129), null, 1],
  },
  {
    accepted: ["", "x".repeat(1000)],
    field: "typed",
    rejected: ["x".repeat(1001), null, 1],
  },
  {
    accepted: [0, 1, 86_400_000],
    field: "latencyMs",
    rejected: [-1, 0.5, 86_400_001, Number.NaN, Infinity, -Infinity, "1", null],
  },
  {
    accepted: [
      NOW.toISOString(),
      "2026-08-10T09:00:00Z",
      "2026-08-10T11:00:00+02:00",
    ],
    field: "reviewedAt",
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
    accepted: [0, 1, 42],
    field: "expectedReps",
    rejected: [-1, 0.5, Number.NaN, Infinity, -Infinity, "0", null],
  },
  {
    accepted: [1, 2, 3, 4],
    field: "rating",
    rejected: [0, 5, 2.5, "3", null, Number.NaN],
  },
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
        expect(
          v.safeParse(AnswerCommand, { ...valid, [field]: value }).success
        ).toBe(false);
      });
    }
  }

  for (const phase of ["guess", "recall"] as const) {
    const input =
      phase === "guess"
        ? { ...valid, expectedReps: 0, phase, rating: null }
        : valid;
    for (const field of Object.keys(valid)) {
      it(`requires ${field} for ${phase}`, () => {
        const missing = Object.fromEntries(
          Object.entries(input).filter(([key]) => key !== field)
        );
        expect(v.safeParse(AnswerCommand, missing).success).toBe(false);
      });
    }
    for (const extra of ["correct", "stateBefore", "unexpected"]) {
      it(`rejects unknown ${extra} key for ${phase}`, () => {
        expect(
          v.safeParse(AnswerCommand, { ...input, [extra]: true }).success
        ).toBe(false);
      });
    }
    // Both variant branches must retain the same field validators.
    for (const { field, rejected } of boundaries.filter(
      (boundary) => !["rating", "expectedReps"].includes(boundary.field)
    )) {
      it(`rejects all invalid ${field} values for ${phase}`, () => {
        for (const value of rejected) {
          expect(
            v.safeParse(AnswerCommand, { ...input, [field]: value }).success
          ).toBe(false);
        }
      });
    }
  }

  it("accepts only an unrated revision-zero guess", () => {
    const guess = { ...valid, expectedReps: 0, phase: "guess", rating: null };
    expect<unknown>(v.parse(AnswerCommand, guess)).toEqual(guess);
    for (const rating of [0, 1, 2, 3, 4, "3", undefined]) {
      expect(v.safeParse(AnswerCommand, { ...guess, rating }).success).toBe(
        false
      );
    }
    for (const expectedReps of [-1, 0.5, 1, 2, "0", null]) {
      expect(
        v.safeParse(AnswerCommand, { ...guess, expectedReps }).success
      ).toBe(false);
    }
  });

  for (const phase of ["exposure", "feedback", "", null, 0]) {
    it(`rejects unknown phase ${phase}`, () => {
      expect(v.safeParse(AnswerCommand, { ...valid, phase }).success).toBe(
        false
      );
    });
  }

  for (const phase of ["guess", "recall"] as const) {
    it(`preserves persisted JSON field order for ${phase} regardless of input order`, () => {
      const parsed = v.parse(AnswerCommand, {
        expectedReps: phase === "guess" ? 0 : 2,
        id: ID,
        latencyMs: 1200,
        phase,
        rating: phase === "guess" ? null : 3,
        reviewedAt: NOW.toISOString(),
        typed: "chien",
        wordId: "chien",
      });
      expect(JSON.stringify(parsed)).toBe(
        `{"id":"${ID}","wordId":"chien","phase":"${phase}","typed":"chien","rating":${phase === "guess" ? "null" : "3"},"latencyMs":1200,"reviewedAt":"2026-08-10T09:00:00.123Z","expectedReps":${phase === "guess" ? 0 : 2}}`
      );
    });
  }
});

const attempt = (): Attempt => {
  const scheduler = fsrs({ enable_short_term: true });
  const firstAt = new Date("2026-08-01T09:00:00Z");
  const first = scheduler.next(
    createEmptyCard(firstAt),
    firstAt,
    Rating.Good
  ).card;
  const stateBefore = scheduler.next(
    first,
    new Date("2026-08-02T09:00:00Z"),
    Rating.Good
  ).card;
  return {
    correct: true,
    latencyMs: 1234,
    phase: "recall",
    rating: Rating.Hard,
    reviewedAt: NOW,
    stateBefore,
    typed: " CHIEN ",
    wordId: "chien",
  };
};

describe("commandFor", () => {
  it("copies the actual previous revision, text, rating, latency and timestamp without mutating the attempt", () => {
    const input = attempt();
    const original = JSON.stringify(input);
    expect(input.stateBefore.reps).toBe(2);
    const command = commandFor(input);
    expect(command).toEqual({
      expectedReps: 2,
      id: command.id,
      latencyMs: 1234,
      phase: "recall",
      rating: 2,
      reviewedAt: "2026-08-10T09:00:00.123Z",
      typed: " CHIEN ",
      wordId: "chien",
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
      `{"id":"${command.id}","wordId":"chien","phase":"recall","typed":" CHIEN ","rating":2,"latencyMs":1234,"reviewedAt":"2026-08-10T09:00:00.123Z","expectedReps":2}`
    );
  });

  it("mints a distinct valid UUID for every command, even from the same attempt", () => {
    const input = attempt();
    const ids = Array.from({ length: 32 }, () => commandFor(input).id);
    expect(new Set(ids).size).toBe(32);
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      );
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
      `{"id":"${command.id}","wordId":"chien","phase":"guess","typed":" CHIEN ","rating":null,"latencyMs":1234,"reviewedAt":"2026-08-10T09:00:00.123Z","expectedReps":0}`
    );
  });

  it("refuses invalid attempts instead of emitting invalid commands", () => {
    expect(() => commandFor({ ...attempt(), latencyMs: -1 })).toThrow();
    expect(() =>
      commandFor({ ...attempt(), phase: "guess", rating: Rating.Good })
    ).toThrow();
    expect(() =>
      commandFor({ ...attempt(), phase: "guess", rating: null })
    ).toThrow();
    expect(() =>
      commandFor({ ...attempt(), reviewedAt: new Date(Number.NaN) })
    ).toThrow();
  });
});
