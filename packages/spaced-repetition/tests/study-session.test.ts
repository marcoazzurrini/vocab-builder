import { beforeEach, describe, expect, it } from "bun:test";

import { Rating, State, createEmptyCard } from "ts-fsrs";
import type { Card as FsrsCard } from "ts-fsrs";

import type { Attempt, SessionAttempt } from "../src/answer-command";
import type { Word } from "../src/restore-progress";
import type { Card } from "../src/review-scheduling";
import { startSession } from "../src/study-session";
import type { Session } from "../src/study-session";

const checkedFixture = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected a present test fixture");
  }
  return value;
};

const START = new Date("2026-08-10T09:00:00");

const cardFor = (word: Word, fsrs: FsrsCard): Card => ({
  fsrs,
  wordId: word.id,
});

const CHIEN: Word = {
  freqRank: 1,
  gloss: "cane",
  hint: null,
  id: "w-chien",
  image: "🐶",
  kind: "word",
  text: "chien",
};

const FENETRE: Word = {
  freqRank: 2,
  gloss: "finestra",
  hint: null,
  id: "w-fenetre",
  image: "🪟",
  kind: "word",
  text: "fenêtre",
};

let clockMs: number;
let attempts: SessionAttempt[];
let changed: Card[];

beforeEach(() => {
  clockMs = START.getTime();
  attempts = [];
  changed = [];
});

const tick = (ms: number) => {
  clockMs += ms;
};

const makeSession = (
  words: Word[],
  newPerDay = 10,
  cards: Card[] = []
): Session =>
  startSession({
    accept: ({ attempt, card }) => {
      attempts.push(attempt);
      if (card) {
        changed.push(card);
      }
    },
    cards,
    clock: () => new Date(clockMs),
    newPerDay,
    words,
  });

/** A completed teaching restored at its first recall boundary. */
const recallSession = (words: Word[], newPerDay = words.length): Session =>
  makeSession(
    words,
    newPerDay,
    words.map((word) => ({
      fsrs: createEmptyCard(new Date(clockMs)),
      initialRecallAt: new Date(clockMs).toISOString(),
      wordId: word.id,
    }))
  );

/** Grade a word whose persisted teaching is already due. */
const introduce = (
  words: Word[],
  typed: string,
  effort: "hard" | "good" | "easy"
): Session => {
  const session = recallSession(words);
  session.submitRecall(typed, effort);
  return session;
};

/** Answer everything until the session pauses or finishes. */
const drain = (session: Session, answerFor: (gloss: string) => string) => {
  for (let guard = 0; guard < 200; guard += 1) {
    const { view } = session;
    if (view.phase === "done" || view.phase === "caughtUp") {
      return;
    }
    if (view.phase === "exposure") {
      session.exposureDone();
    } else if (view.phase === "recall") {
      session.submitRecall(answerFor(view.prompt.gloss), "good");
    } else {
      session.dismissFeedback();
    }
    tick(20_000);
  }
  throw new Error("session never finished");
};

describe("session", () => {
  describe("a new word", () => {
    it("starts by teaching the answer, without an active guess API", () => {
      const s = makeSession([CHIEN]);
      expect(s.view).toEqual({
        answer: "chien",
        phase: "exposure",
        prompt: { gloss: "cane", hint: null, image: "🐶", kind: "word" },
      });
      expect("submitGuess" in s).toBe(false);
    });

    it("reveals the word at exposure without writing progress", () => {
      const s = makeSession([CHIEN]);
      expect(s.view).toMatchObject({ answer: "chien", phase: "exposure" });
      expect(attempts).toEqual([]);
      expect(changed).toEqual([]);
    });

    it("logs teaching without any rating or fabricated answer", () => {
      const s = makeSession([CHIEN]);
      tick(3000);
      s.exposureDone();
      expect(attempts).toEqual([
        {
          latencyMs: 3000,
          phase: "teach",
          reviewedAt: new Date(clockMs),
          wordId: CHIEN.id,
        },
      ]);
      expect(changed[0]).toMatchObject({
        fsrs: { due: new Date(clockMs + 60_000), reps: 0 },
        initialRecallAt: new Date(clockMs + 60_000).toISOString(),
      });
      expect(changed[0]?.fsrs.last_review).toBeUndefined();
    });

    it("requires no typing to complete teaching", () => {
      const s = makeSession([CHIEN]);
      expect(() => s.exposureDone()).not.toThrow();
      expect(attempts[0]).toMatchObject({ phase: "teach" });
      expect(attempts[0]).not.toHaveProperty("typed");
    });

    it("does not classify teaching as correct or wrong", () => {
      const s = makeSession([CHIEN]);
      s.exposureDone();
      expect(attempts[0]).not.toHaveProperty("correct");
      expect(s.view).toMatchObject({
        stats: { correct: 0, introduced: 1, recalls: 0, wrong: 0 },
      });
    });

    it("withholds Easy on the first recall", () => {
      const s = recallSession([CHIEN]);
      expect(s.view).toMatchObject({
        efforts: ["hard", "good"],
        phase: "recall",
      });
      expect(JSON.stringify(s.view)).not.toContain("chien");
    });

    it("offers Easy once the card has been rated", () => {
      const rated = {
        ...createEmptyCard(new Date(clockMs)),
        reps: 1,
        state: State.Learning,
      };
      const s = makeSession([CHIEN], 0, [{ fsrs: rated, wordId: CHIEN.id }]);
      expect(s.view).toMatchObject({
        efforts: ["hard", "good", "easy"],
        phase: "recall",
      });
    });
  });

  describe("grading", () => {
    it("rates a correct answer with the effort pressed", () => {
      introduce([CHIEN], "chien", "hard");
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ correct: true, rating: Rating.Hard });
    });

    it("rates a wrong answer Again regardless of effort", () => {
      introduce([CHIEN], "chein", "good");
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ correct: false, rating: Rating.Again });
    });

    it("treats a missing accent as wrong", () => {
      introduce([FENETRE], "fenetre", "good");
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ correct: false, rating: Rating.Again });
    });

    it("falls back to Good when an unoffered effort is pressed", () => {
      const s = recallSession([CHIEN]);
      // not offered on a first recall
      s.submitRecall("chien", "easy");
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ rating: Rating.Good });
    });

    it("creates an unrated teaching schedule before the first real rating", () => {
      const s = makeSession([CHIEN]);
      expect(changed).toHaveLength(0);
      s.exposureDone();
      expect(changed).toHaveLength(1);
      const card = checkedFixture(changed[0]);
      expect(card.fsrs.reps).toBe(0);
      tick(60_000);
      const resumed = makeSession([CHIEN], 0, [card]);
      resumed.submitRecall("chien", "good");
      expect(changed).toHaveLength(2);
      expect(checkedFixture(changed[1]).wordId).toBe(CHIEN.id);
      expect(checkedFixture(changed[1]).fsrs.reps).toBe(1);
    });

    it("captures the state from before the answer, so history can be replayed", () => {
      introduce([CHIEN], "chien", "good");
      const recall = checkedFixture(
        attempts.find((a): a is Attempt => a.phase === "recall")
      );
      expect(recall.stateBefore.state).toBe(State.New);
      expect(recall.stateBefore.reps).toBe(0);
      // The card itself has moved on; the attempt kept the earlier state.
      expect(checkedFixture(changed.at(-1)).fsrs.reps).toBe(1);
    });
  });

  describe("flow", () => {
    it("moves straight on after a correct answer", () => {
      const s = recallSession([CHIEN, FENETRE], 2);
      s.submitRecall("chien", "good");
      // No feedback screen to dismiss — there is nothing to read.
      expect(s.view.phase).not.toBe("feedback");
    });

    it("pauses on a wrong answer and shows the correct spelling", () => {
      const s = introduce([FENETRE], "fenetre", "good");
      expect(s.view).toEqual({
        expected: "fenêtre",
        phase: "feedback",
        typed: "fenetre",
      });
    });

    it("carries on after the feedback is dismissed", () => {
      const s = recallSession([CHIEN, FENETRE], 2);
      s.submitRecall("chein", "good");
      expect(s.view.phase).toBe("feedback");
      s.dismissFeedback();
      expect(s.view.phase).not.toBe("feedback");
    });

    it("puts other work between a failure and its return, even after a slow feedback", () => {
      // Sixty seconds staring at the feedback screen makes the failed card
      // genuinely due again at dismissal. It must still not come straight
      // back while another card could go between.
      const s = recallSession([CHIEN, FENETRE], 2);
      s.submitRecall("zzz", "good");
      expect(s.view.phase).toBe("feedback");

      tick(61_000);
      s.dismissFeedback();
      expect(s.view).toMatchObject({
        phase: "recall",
        prompt: { gloss: "finestra" },
      });
    });

    it("refuses a call made in the wrong phase", () => {
      const s = makeSession([CHIEN]);
      expect(() => s.dismissFeedback()).toThrow(/expected phase/u);
      expect(() => s.submitRecall("chien", "good")).toThrow(/expected phase/u);
    });
  });

  describe("allowance and ending", () => {
    it("never introduces more than the daily allowance", () => {
      const s = makeSession([CHIEN, FENETRE], 1);
      s.exposureDone();
      // Caught up, not done: chien's next learning step is still coming today.
      expect(s.view).toMatchObject({
        phase: "caughtUp",
        stats: { introduced: 1 },
      });
    });

    it("counts words already introduced earlier today", () => {
      const s = startSession({
        cards: [],
        clock: () => new Date(clockMs),
        introducedToday: 3,
        newPerDay: 3,
        words: [CHIEN, FENETRE],
      });
      expect(s.view.phase).toBe("done");
    });

    it("is done immediately when there is nothing to do", () => {
      const s = makeSession([], 10);
      expect(s.view).toMatchObject({ phase: "done" });
    });

    it("waits rather than repeating the card just answered", () => {
      // The gap one card cannot fill is an honest pause, not an ending: the
      // session says when the card comes due, and the screen rebuilds then.
      const s = makeSession([CHIEN], 1);
      s.exposureDone();
      expect(s.view).toMatchObject({
        nextDueAt: checkedFixture(changed.at(-1)).fsrs.due,
        phase: "caughtUp",
      });
    });

    it("reports what happened", () => {
      const s = recallSession([CHIEN, FENETRE], 2);
      drain(s, (gloss) => (gloss === "cane" ? "chien" : "fenêtre"));
      const { view } = s;
      expect(view.phase).toBe("done");
      if (view.phase !== "done") {
        return;
      }
      expect(view.stats.introduced).toBe(0);
      expect(view.stats.wrong).toBe(0);
      expect(view.stats.correct).toBe(view.stats.recalls);
    });

    it("counts a wrong answer", () => {
      const s = introduce([FENETRE], "fenetre", "good");
      s.dismissFeedback();
      // Caught up, not done: the failed card comes back in a minute.
      expect(s.view).toMatchObject({
        phase: "caughtUp",
        stats: { correct: 0, introduced: 0, recalls: 1, wrong: 1 },
      });
    });
  });

  describe("resuming with cards that already exist", () => {
    // Every other test starts from an empty collection, which is only ever true
    // on day one. These cover the case that is true every day after.
    it("resumes a guessed word at its exposure, not at a guess", () => {
      // An unrated card in the deck can only mean the word was guessed and the
      // app closed before its first rating: nothing is written before the
      // guess, and a guess is logged exactly once. So the pretest is already
      // on record and the word is shown again instead.
      const s = makeSession([CHIEN], 10, [
        cardFor(CHIEN, createEmptyCard(new Date(clockMs))),
      ]);
      expect(s.view).toMatchObject({ answer: "chien", phase: "exposure" });
    });

    it("does not spend allowance again on a resumed word", () => {
      // Its guess already counts in introducedToday, so resuming must not take
      // a second slot on top of that.
      const s = startSession({
        accept: ({ attempt, card }) => {
          attempts.push(attempt);
          if (card) {
            changed.push(card);
          }
        },
        cards: [cardFor(CHIEN, createEmptyCard(new Date(clockMs)))],
        clock: () => new Date(clockMs),
        introducedToday: 1,
        newPerDay: 1,
        words: [CHIEN, FENETRE],
      });
      expect(s.view.phase).toBe("exposure");
      s.exposureDone();
      tick(60_000);
      const resumed = makeSession([CHIEN], 0, [checkedFixture(changed.at(-1))]);
      resumed.submitRecall("chien", "good");
      // fenêtre must not follow: the single slot was spent on chien already.
      // Caught up rather than done, because chien itself is still coming today.
      expect(s.view.phase).toBe("caughtUp");
    });

    it("logs no second guess for a resumed word", () => {
      // One guess per word is a schema-level promise (a partial unique index),
      // so the session must never emit another.
      const s = makeSession([CHIEN], 10, [
        cardFor(CHIEN, createEmptyCard(new Date(clockMs))),
      ]);
      s.exposureDone();
      tick(60_000);
      const resumed = makeSession([CHIEN], 0, [checkedFixture(changed.at(-1))]);
      resumed.submitRecall("chien", "good");
      expect(attempts.filter((a) => a.phase === "guess")).toHaveLength(0);
    });

    it("does not write the card again when resuming", () => {
      makeSession([CHIEN], 10, [
        cardFor(CHIEN, createEmptyCard(new Date(clockMs))),
      ]);
      expect(changed).toHaveLength(0);
    });

    it("sends a card that has been rated straight to recall", () => {
      const rated = createEmptyCard(new Date(clockMs));
      const s = makeSession([CHIEN], 0, [
        cardFor(CHIEN, { ...rated, reps: 1, state: State.Learning }),
      ]);
      expect(s.view.phase).toBe("recall");
    });
  });

  describe("a session that spans several words", () => {
    it("introduces every word before asking for any of them back", () => {
      // The first recall of a word must not follow its exposure directly:
      // producing it two seconds after seeing it is trivial, and that rating is
      // FSRS's first — the one that sets initial difficulty.
      const words = Array.from({ length: 5 }, (_, i) => ({
        ...CHIEN,
        freqRank: i,
        gloss: `parola${i}`,
        id: `w${i}`,
        text: `mot${i}`,
      }));
      const s = makeSession(words, 5);
      const phases: string[] = [];

      for (let i = 0; i < 5; i += 1) {
        phases.push(s.view.phase);
        s.exposureDone();
      }
      expect(phases).toEqual(Array.from({ length: 5 }, () => "exposure"));
      expect(attempts.map((attempt) => attempt.phase)).toEqual(
        Array.from({ length: 5 }, () => "teach")
      );
      expect(s.view.phase).toBe("caughtUp");
      tick(60_000);
      const resumed = makeSession(words, 0, changed);
      expect(resumed.view.phase).toBe("recall");
    });
  });
});
