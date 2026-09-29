import { describe, expect, it } from "bun:test";

import { createEmptyCard, State } from "ts-fsrs";
import * as v from "valibot";

import { commandFor } from "../src/answer-command";
import {
  initialRecallAt,
  teachingSchedule,
  evaluateAnswer,
  RevisionConflict,
} from "../src/evaluate-answer";
import { AnswerCommand, createSession } from "../src/index";
import type { ReviewSnapshot } from "../src/index";
import { restoreProgress } from "../src/restore-progress";

const reviewedAt = "2026-09-10T09:00:00.123Z";
const due = "2026-09-10T09:01:00.123Z";
const word = {
  freqRank: 1,
  gloss: "cane",
  hint: null,
  id: "chien",
  image: null,
  kind: "word" as const,
  text: "chien",
};
const teaching = { initialRecallAt: due, reviewedAt, wordId: word.id };
const snapshot = (): ReviewSnapshot => ({
  cards: [],
  guesses: [],
  teachings: [teaching],
  words: [word],
});
const teach = () =>
  commandFor({
    latencyMs: 1234,
    phase: "teach",
    reviewedAt: new Date(reviewedAt),
    wordId: word.id,
  });

describe("durable teaching contract", () => {
  it("serializes exactly the strict teaching variant", () => {
    const command = teach();
    expect(command).toEqual({
      expectedReps: 0,
      id: command.id,
      latencyMs: 1234,
      phase: "teach",
      reviewedAt,
      wordId: word.id,
    });
    expect(JSON.stringify(command)).toBe(
      `{"id":"${command.id}","wordId":"chien","phase":"teach","latencyMs":1234,"reviewedAt":"${reviewedAt}","expectedReps":0}`
    );
    expect(v.parse(AnswerCommand, command)).toEqual(command);
    expect(teach().id).not.toBe(command.id);
  });
  it.each(["typed", "rating", "correct", "stateBefore", "unexpected"])(
    "rejects extra %s on teaching",
    (key) => {
      expect(
        v.safeParse(AnswerCommand, { ...teach(), [key]: null }).success
      ).toBe(false);
    }
  );
  it.each(["id", "wordId", "phase", "latencyMs", "reviewedAt", "expectedReps"])(
    "requires teaching %s",
    (key) => {
      const missing = Object.fromEntries(
        Object.entries(teach()).filter(([name]) => name !== key)
      );
      expect(v.safeParse(AnswerCommand, missing).success).toBe(false);
    }
  );
  it.each([
    { expectedReps: 1 },
    { expectedReps: -1 },
    { expectedReps: "0" },
    { latencyMs: -1 },
    { latencyMs: 0.5 },
    { latencyMs: 86_400_001 },
    { reviewedAt: "yesterday" },
    { id: "constant" },
    { wordId: "" },
  ])("rejects invalid teaching fields %j", (invalid) => {
    expect(v.safeParse(AnswerCommand, { ...teach(), ...invalid }).success).toBe(
      false
    );
  });
  it("seeds an empty FSRS card exactly sixty seconds after completion", () => {
    expect(initialRecallAt(reviewedAt)).toBe(due);
    expect(initialRecallAt("2026-09-10T23:59:30.000Z")).toBe(
      "2026-09-11T00:00:30.000Z"
    );
    const schedule = JSON.parse(teachingSchedule(due));
    expect(schedule).toEqual({ ...createEmptyCard(new Date(due)), due });
    expect(schedule.reps).toBe(0);
    expect(schedule).not.toHaveProperty("last_review");
  });
  it.each(["", "not-a-date"])(
    "rejects unreadable helper timestamps %s",
    (invalid) => {
      expect(() => initialRecallAt(invalid)).toThrow();
      expect(() => teachingSchedule(invalid)).toThrow();
    }
  );
  it.each([-1, 0, 1])(
    "restores first recall at exact due offset %i",
    (offset) => {
      const now = new Date(new Date(due).getTime() + offset);
      const session = createSession({ clock: () => now, snapshot: snapshot() });
      if (offset < 0) {
        expect(session.view).toMatchObject({
          nextDueAt: new Date(due),
          phase: "caughtUp",
        });
      } else {
        expect(session.view.phase).toBe("recall");
      }
    }
  );
  it("honors the server's persisted due instead of recomputing from completion", () => {
    const laterDue = "2026-09-10T09:07:00.123Z";
    const saved = {
      ...snapshot(),
      teachings: [{ ...teaching, initialRecallAt: laterDue }],
    };
    expect(
      createSession({ clock: () => new Date(due), snapshot: saved }).view
    ).toMatchObject({ nextDueAt: new Date(laterDue), phase: "caughtUp" });
    expect(
      createSession({ clock: () => new Date(laterDue), snapshot: saved }).view
        .phase
    ).toBe("recall");
  });
  it("does not recall an unrated word early when it is the only remaining work", () => {
    const session = createSession({
      clock: () => new Date(reviewedAt),
      snapshot: snapshot(),
    });
    expect(session.view.phase).toBe("caughtUp");
    expect(() => session.submitRecall(word.text, "good")).toThrow(
      /expected phase/u
    );
  });
  it("rejects a clock rollback before first due without accepting or publishing", () => {
    let now = new Date(due);
    const commands: AnswerCommand[] = [];
    const session = createSession({
      acceptAnswer: (command) => {
        commands.push(command);
      },
      clock: () => now,
      snapshot: snapshot(),
    });
    const before = session.view;
    now = new Date(new Date(due).getTime() - 1);
    expect(() => session.submitRecall(word.text, "good")).toThrow(
      RevisionConflict
    );
    expect(session.view).toEqual(before);
    expect(commands).toEqual([]);
    now = new Date(due);
    session.submitRecall(word.text, "good");
    expect(commands).toHaveLength(1);
  });
  it("starts fresh exposure after abandonment but never repeats accepted teaching", () => {
    const fresh = { ...snapshot(), teachings: [] };
    const commands: AnswerCommand[] = [];
    const session = createSession({
      acceptAnswer: (command) => {
        commands.push(command);
      },
      clock: () => new Date(reviewedAt),
      snapshot: fresh,
    });
    expect(session.view.phase).toBe("exposure");
    expect(
      createSession({ clock: () => new Date(reviewedAt), snapshot: fresh }).view
        .phase
    ).toBe("exposure");
    expect(commands).toEqual([]);
    session.exposureDone();
    expect(commands).toHaveLength(1);
    expect(
      createSession({ clock: () => new Date(reviewedAt), snapshot: snapshot() })
        .view.phase
    ).toBe("caughtUp");
  });
  it("retains teaching when an unrated cache row also exists", () => {
    const saved = {
      ...snapshot(),
      cards: [
        {
          schedule: JSON.stringify(createEmptyCard(new Date(reviewedAt))),
          wordId: word.id,
        },
      ],
    };
    const progress = restoreProgress(
      saved.words,
      saved.cards,
      saved.guesses,
      new Date(reviewedAt),
      0,
      saved.teachings
    );
    expect(progress.cards).toHaveLength(1);
    expect(progress.cards[0]).toMatchObject({
      fsrs: { due: new Date(due), reps: 0 },
      initialRecallAt: due,
    });
    expect(
      createSession({ clock: () => new Date(reviewedAt), snapshot: saved }).view
        .phase
    ).toBe("caughtUp");
  });
  it("keeps rated schedules unchanged and does not require teaching again", () => {
    const card = {
      ...createEmptyCard(new Date(due)),
      difficulty: 3,
      lapses: 2,
      last_review: new Date("2026-09-08T09:00:00Z"),
      reps: 7,
      stability: 8,
      state: State.Review,
    };
    for (const teachings of [[], [teaching]]) {
      const saved = {
        ...snapshot(),
        cards: [{ schedule: JSON.stringify(card), wordId: word.id }],
        teachings,
      };
      const restored = restoreProgress(
        saved.words,
        saved.cards,
        saved.guesses,
        new Date(due),
        0,
        teachings
      );
      expect(restored.cards).toEqual([{ fsrs: card, wordId: word.id }]);
      expect(
        createSession({ clock: () => new Date(due), snapshot: saved }).view
          .phase
      ).toBe("recall");
    }
  });
  it("teaches legacy guesses once without charging their allowance twice", () => {
    const yesterday = "2026-09-09T09:00:00.123Z";
    const saved = {
      ...snapshot(),
      guesses: [{ reviewedAt: yesterday, wordId: word.id }],
      teachings: [],
    };
    const commands: AnswerCommand[] = [];
    const session = createSession({
      acceptAnswer: (command) => {
        commands.push(command);
      },
      clock: () => new Date(reviewedAt),
      settings: { dayRolloverHour: 0, lang: "fr", newPerDay: 0 },
      snapshot: saved,
    });
    expect(session.view.phase).toBe("exposure");
    session.exposureDone();
    expect(session.view).toMatchObject({
      phase: "caughtUp",
      stats: { introduced: 0, recalls: 0 },
    });
    expect(commands.map((command) => command.phase)).toEqual(["teach"]);
    const restored = restoreProgress(
      saved.words,
      [],
      saved.guesses,
      new Date(reviewedAt),
      0,
      [teaching]
    );
    expect(restored.introducedToday).toBe(0);
    expect(restored.cards).toHaveLength(1);
    const todayGuess = [{ reviewedAt, wordId: word.id }];
    expect(
      restoreProgress(saved.words, [], todayGuess, new Date(reviewedAt), 0, [
        teaching,
      ]).introducedToday
    ).toBe(1);
    expect(
      restoreProgress(saved.words, [], [], new Date(reviewedAt), 0, [
        teaching,
        teaching,
      ]).introducedToday
    ).toBe(1);
  });
  it("preserves legacy guess and immediate recall replay without fabricating teaching", () => {
    const command = {
      expectedReps: 0,
      id: crypto.randomUUID(),
      latencyMs: 10,
      phase: "guess",
      rating: null,
      reviewedAt,
      typed: "",
      wordId: word.id,
    };
    const guess = evaluateAnswer(
      command,
      word.text,
      undefined,
      new Date(reviewedAt)
    );
    expect(guess.nextSchedule).toBeNull();
    expect(guess.revision).toBe(0);
    expect(guess.correct).toBe(false);
    const recall = evaluateAnswer(
      { ...command, phase: "recall", rating: 3, typed: word.text },
      word.text,
      undefined,
      new Date(reviewedAt)
    );
    expect(recall.revision).toBe(1);
    expect(recall.correct).toBe(true);
  });
});
