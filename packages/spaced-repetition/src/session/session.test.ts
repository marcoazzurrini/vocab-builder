import { Rating, State, createEmptyCard } from "ts-fsrs";
import type { Card as FsrsCard } from "ts-fsrs";
import { beforeEach, describe, expect, it } from "bun:test";
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

beforeEach(() => {
  clockMs = START.getTime();
  attempts = [];
  changed = [];
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

/** Work through introductions until a recall is asked for. */
function stepUntilRecall(session: Session) {
  for (let i = 0; i < 50; i++) {
    const view = session.view;
    if (view.phase === "guess") session.submitGuess("");
    else if (view.phase === "exposure") session.exposureDone();
    else return;
  }
}

/** Answer everything until the session pauses or finishes. */
function drain(session: Session, answerFor: (gloss: string) => string) {
  for (let guard = 0; guard < 200; guard++) {
    const view = session.view;
    if (view.phase === "done" || view.phase === "caughtUp") return;
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

    it("offers Easy once the card has been rated", () => {
      const rated = { ...createEmptyCard(new Date(clockMs)), reps: 1, state: State.Learning };
      const s = makeSession([CHIEN], 0, [{ wordId: CHIEN.id, fsrs: rated }]);
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

    it("announces the card only when FSRS first rates it", () => {
      // Attempts are keyed by word, so the guess needs no card row to point
      // at. Nothing is written until there is scheduling state worth writing.
      const s = makeSession([CHIEN]);
      expect(changed).toHaveLength(0);

      s.submitGuess("cani");
      s.exposureDone();
      expect(changed).toHaveLength(0);

      s.submitRecall("chien", "good");
      expect(changed).toHaveLength(1);
      expect(changed[0]!.wordId).toBe(CHIEN.id);
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
      stepUntilRecall(s);
      s.submitRecall("chien", "good");
      // No feedback screen to dismiss — there is nothing to read.
      expect(s.view.phase).not.toBe("feedback");
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
      stepUntilRecall(s);
      s.submitRecall("chein", "good");
      expect(s.view.phase).toBe("feedback");
      s.dismissFeedback();
      expect(s.view.phase).not.toBe("feedback");
    });

    it("puts other work between a failure and its return, even after a slow feedback", () => {
      // Sixty seconds staring at the feedback screen makes the failed card
      // genuinely due again at dismissal. It must still not come straight
      // back while another card could go between.
      const s = makeSession([CHIEN, FENETRE], 2);
      stepUntilRecall(s); // both introduced; chien is asked first
      s.submitRecall("zzz", "good");
      expect(s.view.phase).toBe("feedback");

      tick(61_000);
      s.dismissFeedback();
      expect(s.view).toMatchObject({ phase: "recall", prompt: { gloss: "finestra" } });
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
      // Caught up, not done: chien's next learning step is still coming today.
      expect(s.view).toMatchObject({ phase: "caughtUp", stats: { introduced: 1 } });
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

    it("waits rather than repeating the card just answered", () => {
      // The gap one card cannot fill is an honest pause, not an ending: the
      // session says when the card comes due, and the screen rebuilds then.
      const s = makeSession([CHIEN], 1);
      introduce(s, "chien", "good");
      expect(s.view).toMatchObject({
        phase: "caughtUp",
        nextDueAt: changed.at(-1)!.fsrs.due,
      });
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
      // Caught up, not done: the failed card comes back in a minute.
      expect(s.view).toMatchObject({
        phase: "caughtUp",
        stats: { introduced: 1, recalls: 1, correct: 0, wrong: 1 },
      });
    });
  });

  describe("resuming with cards that already exist", () => {
    // Every other test starts from an empty collection, which is only ever true
    // on day one. These cover the case that is true every day after.
    function cardFor(word: Word, fsrs: FsrsCard): Card {
      return { wordId: word.id, fsrs };
    }

    it("resumes a guessed word at its exposure, not at a guess", () => {
      // An unrated card in the deck can only mean the word was guessed and the
      // app closed before its first rating: nothing is written before the
      // guess, and a guess is logged exactly once. So the pretest is already
      // on record and the word is shown again instead.
      const s = makeSession([CHIEN], 10, [cardFor(CHIEN, createEmptyCard(new Date(clockMs)))]);
      expect(s.view).toMatchObject({ phase: "exposure", answer: "chien" });
    });

    it("does not spend allowance again on a resumed word", () => {
      // Its guess already counts in introducedToday, so resuming must not take
      // a second slot on top of that.
      const s = createSession({
        words: [CHIEN, FENETRE],
        cards: [cardFor(CHIEN, createEmptyCard(new Date(clockMs)))],
        newPerDay: 1,
        introducedToday: 1,
        clock: () => new Date(clockMs),
        onAttempt: (a) => attempts.push(a),
        onCardChange: (c) => changed.push(c),
      });
      expect(s.view.phase).toBe("exposure");
      s.exposureDone();
      s.submitRecall("chien", "good");
      // fenêtre must not follow: the single slot was spent on chien already.
      // Caught up rather than done, because chien itself is still coming today.
      expect(s.view.phase).toBe("caughtUp");
    });

    it("logs no second guess for a resumed word", () => {
      // One guess per word is a schema-level promise (a partial unique index),
      // so the session must never emit another.
      const s = makeSession([CHIEN], 10, [cardFor(CHIEN, createEmptyCard(new Date(clockMs)))]);
      s.exposureDone();
      s.submitRecall("chien", "good");
      expect(attempts.filter((a) => a.phase === "guess")).toHaveLength(0);
    });

    it("does not write the card again when resuming", () => {
      makeSession([CHIEN], 10, [cardFor(CHIEN, createEmptyCard(new Date(clockMs)))]);
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
        id: `w${i}`,
        text: `mot${i}`,
        gloss: `parola${i}`,
        freqRank: i,
      }));
      const s = makeSession(words, 5);
      const phases: string[] = [];

      for (let i = 0; i < 10; i++) {
        const view = s.view;
        phases.push(view.phase);
        if (view.phase === "guess") s.submitGuess("");
        else if (view.phase === "exposure") s.exposureDone();
        else break;
      }

      // Ten steps: five guesses and five exposures, no recall among them.
      expect(phases).toHaveLength(10);
      expect(phases).not.toContain("recall");
      expect(phases.filter((p) => p === "guess")).toHaveLength(5);
      expect(s.view.phase).toBe("recall");
    });
  });
});
