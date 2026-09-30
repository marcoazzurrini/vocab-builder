import { describe, expect, it } from "bun:test";

import { createEmptyCard, State } from "ts-fsrs";

import { createSession } from "../src/index";
import type { PracticePolicy, ReviewSnapshot, Word } from "../src/index";
import type { Card } from "../src/review-scheduling";
import { pickNext } from "../src/select-next-step";
import type { Queue } from "../src/select-next-step";
import { startSession } from "../src/study-session";
import type { AnswerChange } from "../src/study-session";

const NOW = new Date("2026-09-10T09:00:00.123Z");
const MINUTE = 60_000;
const policy: PracticePolicy = { allowNew: true, dueOnly: true };
const word = (id: string, freqRank: number): Word => ({
  freqRank,
  gloss: `gloss-${id}`,
  hint: null,
  id,
  image: null,
  kind: "word",
  text: `word-${id}`,
});
const words: [Word, Word, Word] = [word("w1", 1), word("w2", 2), word("w3", 3)];
const scheduled = (wordId: string, state: State, due = NOW): Card => ({
  fsrs: { ...createEmptyCard(due), reps: 1, state },
  wordId,
});
const taught = (wordId: string, due = NOW): Card => ({
  fsrs: createEmptyCard(due),
  initialRecallAt: due.toISOString(),
  wordId,
});
const ask = (queue: Partial<Queue> & Pick<Queue, "cards">) =>
  pickNext({
    allowanceLeft: 3,
    now: NOW,
    practicePolicy: policy,
    pulledForward: new Set(),
    words,
    ...queue,
  });

describe("bounded practice queue", () => {
  it.each([
    scheduled("w1", State.Learning),
    taught("w1"),
    scheduled("w1", State.Review),
  ])(
    "prioritizes a genuinely due recall over new introductions: %j",
    (card) => {
      expect(ask({ cards: [card] })).toEqual({ card, do: "recall" });
    }
  );

  it("keeps new-first review ordering unless dueOnly is enabled", () => {
    const card = scheduled("w1", State.Review);
    for (const practicePolicy of [
      undefined,
      { allowNew: true, dueOnly: false },
    ]) {
      expect(ask({ cards: [card], practicePolicy })).toEqual({
        do: "introduce",
        word: words[1],
      });
    }
  });

  it.each([State.Learning, State.Relearning, State.New, State.Review])(
    "never pulls future rated state %s forward",
    (state) => {
      const card = scheduled("w1", state, new Date(NOW.getTime() + MINUTE));
      expect(ask({ allowanceLeft: 0, cards: [card] })).toEqual({
        do: "wait",
        until: card.fsrs.due,
      });
      expect(ask({ cards: [card] })).toEqual({
        do: "introduce",
        word: words[1],
      });
    }
  );

  it("waits for the earliest future due, including reviews beyond today", () => {
    const due = new Date(NOW.getTime() + 3 * 86_400_000);
    const review = scheduled("w1", State.Review, due);
    const later = new Date(due.getTime() + MINUTE);
    expect(
      ask({
        allowanceLeft: 0,
        cards: [
          taught("w2", later),
          scheduled("w3", State.Learning, later),
          review,
        ],
      })
    ).toEqual({ do: "wait", until: due });
  });

  it.each([false, true])(
    "allowNew=false only blocks new introductions, dueOnly=%s",
    (dueOnly) => {
      const practicePolicy = { allowNew: false, dueOnly };
      expect(ask({ cards: [], practicePolicy })).toEqual({ do: "done" });
      const legacy = { fsrs: createEmptyCard(NOW), wordId: "w1" };
      expect(ask({ cards: [legacy], practicePolicy })).toEqual({
        card: legacy,
        do: "expose",
      });
      for (const card of [taught("w1"), scheduled("w1", State.Review)]) {
        expect(ask({ cards: [card], practicePolicy })).toEqual({
          card,
          do: "recall",
        });
      }
    }
  );

  it.each([
    scheduled("w1", State.Learning),
    taught("w1"),
    scheduled("w1", State.Review),
  ])("interleaves the just-shown card but serves it when alone: %j", (card) => {
    expect(ask({ cards: [card], justShownId: "w1" })).toEqual({
      do: "introduce",
      word: words[1],
    });
    expect(ask({ allowanceLeft: 0, cards: [card], justShownId: "w1" })).toEqual(
      {
        card,
        do: "recall",
      }
    );
  });

  it("serves a genuinely due Review even if rated earlier today", () => {
    const card = scheduled("w1", State.Review);
    card.fsrs.last_review = new Date(NOW.getTime() - MINUTE);
    expect(ask({ cards: [card] })).toEqual({ card, do: "recall" });
  });
});

describe("dynamic session practice policy", () => {
  it("reads allowNew initially and again after teaching, preserving the 60-second first recall", () => {
    let allowNew = true;
    let reads = 0;
    const practicePolicy = (): PracticePolicy => {
      reads += 1;
      return { allowNew, dueOnly: true };
    };
    const snapshot: ReviewSnapshot = { cards: [], guesses: [], words };
    const session = createSession({
      clock: () => NOW,
      practicePolicy,
      snapshot,
    });
    expect(reads).toBe(1);
    expect(session.view.phase).toBe("exposure");
    allowNew = false;
    session.exposureDone();
    expect(reads).toBe(2);
    const due = new Date(NOW.getTime() + MINUTE);
    expect(session.view).toMatchObject({
      nextDueAt: due,
      phase: "caughtUp",
      stats: { introduced: 1, recalls: 0 },
    });
    expect(() => session.submitRecall("word-w1", "good")).toThrow(
      /expected phase/u
    );

    const saved: ReviewSnapshot = {
      ...snapshot,
      teachings: [
        {
          initialRecallAt: due.toISOString(),
          reviewedAt: NOW.toISOString(),
          wordId: "w1",
        },
      ],
    };
    const early = createSession({
      clock: () => new Date(due.getTime() - 1),
      practicePolicy,
      snapshot: saved,
    });
    expect(early.view).toMatchObject({ nextDueAt: due, phase: "caughtUp" });
    const ready = createSession({
      clock: () => due,
      practicePolicy,
      snapshot: saved,
    });
    expect(ready.view).toMatchObject({
      phase: "recall",
      prompt: { gloss: "gloss-w1" },
    });
  });

  it("reads policy on correct recall and feedback dismissal, not feedback display", () => {
    let reads = 0;
    let allowNew = false;
    const session = startSession({
      cards: [scheduled("w1", State.Review), scheduled("w2", State.Review)],
      clock: () => NOW,
      newPerDay: 3,
      practicePolicy: () => {
        reads += 1;
        return { allowNew, dueOnly: true };
      },
      words,
    });
    expect(reads).toBe(1);
    session.submitRecall("wrong", "good");
    expect(session.view.phase).toBe("feedback");
    expect(reads).toBe(1);
    session.dismissFeedback();
    expect(reads).toBe(2);
    expect(session.view).toMatchObject({
      phase: "recall",
      prompt: { gloss: "gloss-w2" },
    });
    allowNew = true;
    session.submitRecall("word-w2", "good");
    expect(reads).toBe(3);
    expect(session.view).toMatchObject({
      answer: "word-w3",
      phase: "exposure",
    });
  });

  it("reports a future Review as caughtUp without changing its schedule", () => {
    const due = new Date(NOW.getTime() + MINUTE);
    const card = scheduled("w1", State.Review, due);
    const before = structuredClone(card);
    const session = startSession({
      cards: [card],
      clock: () => NOW,
      newPerDay: 3,
      practicePolicy: () => ({ allowNew: false, dueOnly: true }),
      words,
    });
    expect(session.view).toMatchObject({ nextDueAt: due, phase: "caughtUp" });
    expect(card).toEqual(before);
  });

  it("keeps FSRS ratings and schedules identical with or without a policy", () => {
    const changes: AnswerChange[] = [];
    for (const practicePolicy of [undefined, () => policy]) {
      const session = startSession({
        accept: (change) => {
          changes.push(change);
        },
        cards: [taught("w1")],
        clock: () => NOW,
        newPerDay: 0,
        practicePolicy,
        words,
      });
      session.submitRecall("word-w1", "good");
    }
    expect(changes).toHaveLength(2);
    expect(changes[0]).toEqual(changes[1]);
  });
});
