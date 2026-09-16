import { describe, expect, it } from "bun:test";

import { createEmptyCard } from "ts-fsrs";
import * as v from "valibot";

import { reviveFsrsCard } from "../src/review-scheduling";

const NOW = new Date("2026-08-10T09:00:00");

const parseUnreviewedSchedule = (serialized: string) =>
  v.parse(
    v.record(v.string(), v.union([v.string(), v.number()])),
    JSON.parse(serialized)
  );

describe("reviving persisted review schedules", () => {
  // The failure this guards against is silent: ts-fsrs would do date arithmetic
  // on strings and schedule wrongly without raising anything.
  it("turns date strings back into Dates", () => {
    const original = createEmptyCard(new Date("2026-08-10T09:00:00Z"));
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
    const roundTripped = reviveFsrsCard(JSON.parse(JSON.stringify(original)));

    expect(roundTripped.due).toBeInstanceOf(Date);
    expect(roundTripped.due.getTime()).toBe(original.due.getTime());
  });

  it("leaves last_review undefined when the card has never been reviewed", () => {
    const revived = reviveFsrsCard(
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
      JSON.parse(JSON.stringify(createEmptyCard(new Date())))
    );
    expect(revived.last_review).toBeUndefined();
  });

  it("revives last_review once it exists", () => {
    const reviewed = {
      ...createEmptyCard(new Date()),
      last_review: new Date(),
    };
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
    const revived = reviveFsrsCard(JSON.parse(JSON.stringify(reviewed)));
    expect(revived.last_review).toBeInstanceOf(Date);
  });

  it("defaults learning_steps, which older rows predate", () => {
    const { learning_steps: _, ...withoutSteps } = createEmptyCard(NOW);
    expect(
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise JSON wire serialization, including Date strings and omitted undefined fields.
      reviveFsrsCard(JSON.parse(JSON.stringify(withoutSteps))).learning_steps
    ).toBe(0);
  });

  it("passes through fields it does not know, so an upstream addition survives", () => {
    // ts-fsrs added learning_steps once already. When it adds the next field,
    // stripping it here would quietly corrupt every card on every load.
    const withNewField = {
      ...parseUnreviewedSchedule(JSON.stringify(createEmptyCard(NOW))),
      decay: 0.2,
    };
    const revived = reviveFsrsCard(withNewField);
    expect(revived).toHaveProperty("decay", 0.2);
  });

  describe("refusing state it cannot read", () => {
    // Each of these used to pass straight through the cast and become a wrong
    // schedule that never raised anything.
    const valid = () =>
      parseUnreviewedSchedule(JSON.stringify(createEmptyCard(NOW)));

    it("rejects an unparseable due date", () => {
      expect(() => reviveFsrsCard({ ...valid(), due: "soon" })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects a missing due date", () => {
      const { due: _, ...noDue } = valid();
      expect(() => reviveFsrsCard(noDue)).toThrow(/unreadable/iu);
    });

    it("rejects a stability that arrived as a string", () => {
      expect(() => reviveFsrsCard({ ...valid(), stability: "3.4" })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects NaN, which JSON writes as null", () => {
      expect(() => reviveFsrsCard({ ...valid(), difficulty: null })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects a state outside the enum", () => {
      expect(() => reviveFsrsCard({ ...valid(), state: 7 })).toThrow(
        /unreadable/iu
      );
    });

    it("rejects a negative reps count", () => {
      expect(() => reviveFsrsCard({ ...valid(), reps: -1 })).toThrow(
        /unreadable/iu
      );
    });

    it("names the card, so the row can be found and rebuilt", () => {
      expect(() =>
        reviveFsrsCard({ ...valid(), due: "soon" }, "card-42")
      ).toThrow(/card-42/u);
    });
  });
});
