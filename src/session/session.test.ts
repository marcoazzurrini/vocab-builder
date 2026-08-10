import { Rating, State } from "ts-fsrs";
import { beforeEach, describe, expect, it } from "vitest";
import { createSession } from "./index";
import type { Session } from "./index";
import type { Attempt, Card, Word } from "./types";

const START = new Date("2026-08-10T09:00:00");

const CHIEN: Word = {
  id: "w-chien",
  text: "chien",
  gloss: "cane",
  hint: null,
  image: "🐶",
  kind: "word",
  freqRank: 1,
};

const FENETRE: Word = {
  id: "w-fenetre",
  text: "fenêtre",
  gloss: "finestra",
  hint: null,
  image: "🪟",
  kind: "word",
  freqRank: 2,
};

let clockMs: number;
let attempts: Attempt[];
let changed: Card[];
let idCounter: number;

beforeEach(() => {
  clockMs = START.getTime();
  attempts = [];
  changed = [];
  idCounter = 0;
});

function tick(ms: number) {
  clockMs += ms;
}

function makeSession(words: Word[], newPerDay = 10, cards: Card[] = []): Session {
  return createSession({
    words,
    cards,
    newPerDay,
    clock: () => new Date(clockMs),
    newCardId: () => `card-${++idCounter}`,
    onAttempt: (a) => attempts.push(a),
    onCardChange: (c) => changed.push(c),
  });
}

/** Walk a new word through guess → exposure → recall. */
function introduce(session: Session, typed: string, effort: "hard" | "good" | "easy") {
  session.submitGuess("boh");
  session.exposureDone();
  session.submitRecall(typed, effort);
}

/** Answer everything until the session says it is over. */
function drain(session: Session, answerFor: (gloss: string) => string) {
  for (let guard = 0; guard < 200; guard++) {
    const view = session.view;
    if (view.phase === "done") return;
    if (view.phase === "guess") session.submitGuess("");
    else if (view.phase === "exposure") session.exposureDone();
    else if (view.phase === "recall") session.submitRecall(answerFor(view.prompt.gloss), "good");
    else session.dismissFeedback();
    tick(20_000);
  }
  throw new Error("session never finished");
}

describe("session", () => {
  describe("a new word", () => {
    it("starts with a guess that does not leak the answer", () => {
      const s = makeSession([CHIEN]);
      expect(s.view).toEqual({
        phase: "guess",
        prompt: { gloss: "cane", hint: null, image: "🐶", kind: "word" },
      });
      // The answer is absent from the guess view — not hidden, absent.
      expect(JSON.stringify(s.view)).not.toContain("chien");
    });

    it("reveals the word only at exposure", () => {
      const s = makeSession([CHIEN]);
      s.submitGuess("cane");
      expect(s.view).toMatchObject({ phase: "exposure", answer: "chien" });
    });

    it("logs the guess without rating it", () => {
      const s = makeSession([CHIEN]);
      tick(3000);
      s.submitGuess("cani");

      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        phase: "guess",
        typed: "cani",
        correct: false,
        rating: null,
        latencyMs: 3000,
      });
    });

    it("accepts an empty guess — a shrug is a valid pretest", () => {
      const s = makeSession([CHIEN]);
      expect(() => s.submitGuess("")).not.toThrow();
      expect(attempts[0]).toMatchObject({ typed: "", correct: false, rating: null });
    });

    it("notices a guess that happened to be right, still without rating it", () => {
      const s = makeSession([CHIEN]);
      s.submitGuess("chien");
      expect(attempts[0]).toMatchObject({ correct: true, rating: null });
    });

    it("withholds Easy on the first recall", () => {
      const s = makeSession([CHIEN]);
      s.submitGuess("x");
      s.exposureDone();
      // Easy here would send a word met twenty seconds ago eight days out.
      expect(s.view).toMatchObject({ phase: "recall", efforts: ["hard", "good"] });
    });

    it("offers Easy from the second recall onward", () => {
      const s = makeSession([CHIEN, FENETRE], 2);
      introduce(s, "chien", "good");
      introduce(s, "fenêtre", "good");
      tick(11 * 60_000);
      expect(s.view).toMatchObject({ phase: "recall", efforts: ["hard", "good", "easy"] });
    });
  });

  describe("grading", () => {
    it("rates a correct answer with the effort pressed", () => {
      const s = makeSession([CHIEN]);
      introduce(s, "chien", "hard");
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ correct: true, rating: Rating.Hard });
    });

    it("rates a wrong answer Again regardless of effort", () => {
      const s = makeSession([CHIEN]);
      introduce(s, "chein", "good");
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ correct: false, rating: Rating.Again });
    });

    it("treats a missing accent as wrong", () => {
      const s = makeSession([FENETRE]);
      introduce(s, "fenetre", "good");
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ correct: false, rating: Rating.Again });
    });

    it("falls back to Good when an unoffered effort is pressed", () => {
      const s = makeSession([CHIEN]);
      s.submitGuess("x");
      s.exposureDone();
      s.submitRecall("chien", "easy"); // not offered on a first recall
      const recall = attempts.find((a) => a.phase === "recall");
      expect(recall).toMatchObject({ rating: Rating.Good });
    });

    it("announces a new card before its first attempt is recorded", () => {
      // attempts.card_id is a foreign key, and the guess is recorded before any
      // rating exists — so the card must be announced at creation.
      const s = makeSession([CHIEN]);
      expect(changed).toHaveLength(1);
      expect(changed[0]!.wordId).toBe(CHIEN.id);

      s.submitGuess("cani");
      const guess = attempts.find((a) => a.phase === "guess")!;
      expect(changed.some((c) => c.id === guess.cardId)).toBe(true);
    });

    it("captures the state from before the answer, so history can be replayed", () => {
      const s = makeSession([CHIEN]);
      introduce(s, "chien", "good");
      const recall = attempts.find((a) => a.phase === "recall")!;
      expect(recall.stateBefore.state).toBe(State.New);
      expect(recall.stateBefore.reps).toBe(0);
      // The card itself has moved on; the attempt kept the earlier state.
      expect(changed.at(-1)!.fsrs.reps).toBe(1);
    });
  });

  describe("flow", () => {
    it("moves straight on after a correct answer", () => {
      const s = makeSession([CHIEN, FENETRE], 2);
      introduce(s, "chien", "good");
      // No feedback screen to dismiss — there is nothing to read.
      expect(s.view.phase).toBe("guess");
    });

    it("pauses on a wrong answer and shows the correct spelling", () => {
      const s = makeSession([FENETRE]);
      introduce(s, "fenetre", "good");
      expect(s.view).toEqual({
        phase: "feedback",
        expected: "fenêtre",
        typed: "fenetre",
      });
    });

    it("carries on after the feedback is dismissed", () => {
      const s = makeSession([CHIEN, FENETRE], 2);
      introduce(s, "chein", "good");
      s.dismissFeedback();
      expect(s.view.phase).not.toBe("feedback");
    });

    it("refuses a call made in the wrong phase", () => {
      const s = makeSession([CHIEN]);
      expect(() => s.exposureDone()).toThrow(/expected phase/);
      expect(() => s.submitRecall("chien", "good")).toThrow(/expected phase/);
    });
  });

  describe("allowance and ending", () => {
    it("never introduces more than the daily allowance", () => {
      const s = makeSession([CHIEN, FENETRE], 1);
      introduce(s, "chien", "good");
      expect(s.view.phase).toBe("done");
      expect(s.view).toMatchObject({ stats: { introduced: 1 } });
    });

    it("counts words already introduced earlier today", () => {
      const s = createSession({
        words: [CHIEN, FENETRE],
        cards: [],
        newPerDay: 3,
        introducedToday: 3,
        clock: () => new Date(clockMs),
      });
      expect(s.view.phase).toBe("done");
    });

    it("is done immediately when there is nothing to do", () => {
      const s = makeSession([], 10);
      expect(s.view).toMatchObject({ phase: "done" });
    });

    it("ends rather than repeating the card just answered", () => {
      // The gap it wants cannot be filled by one card; tomorrow will fill it.
      const s = makeSession([CHIEN], 1);
      introduce(s, "chien", "good");
      expect(s.view.phase).toBe("done");
    });

    it("reports what happened", () => {
      const s = makeSession([CHIEN, FENETRE], 2);
      drain(s, (gloss) => (gloss === "cane" ? "chien" : "fenêtre"));
      const view = s.view;
      expect(view.phase).toBe("done");
      if (view.phase !== "done") return;
      expect(view.stats.introduced).toBe(2);
      expect(view.stats.wrong).toBe(0);
      expect(view.stats.correct).toBe(view.stats.recalls);
    });

    it("counts a wrong answer", () => {
      const s = makeSession([FENETRE], 1);
      introduce(s, "fenetre", "good"); // missing accent
      s.dismissFeedback();
      expect(s.view).toMatchObject({
        phase: "done",
        stats: { introduced: 1, recalls: 1, correct: 0, wrong: 1 },
      });
    });
  });

  describe("a session that spans several words", () => {
    it("introduces every word before repeating any of them", () => {
      const words = Array.from({ length: 5 }, (_, i) => ({
        ...CHIEN,
        id: `w${i}`,
        text: `mot${i}`,
        gloss: `parola${i}`,
        freqRank: i,
      }));
      const s = makeSession(words, 5);
      const seen: string[] = [];

      for (let i = 0; i < 5; i++) {
        const view = s.view;
        expect(view.phase).toBe("guess");
        s.submitGuess("");
        s.exposureDone();
        seen.push((s.view as { prompt: { gloss: string } }).prompt.gloss);
        s.submitRecall(`mot${i}`, "good");
        tick(20_000);
      }

      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });
  });
});
