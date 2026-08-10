import { createEmptyCard, fsrs } from "ts-fsrs";
import type { FSRS } from "ts-fsrs";
import { effortsFor, gradeRecall } from "./grading";
import { matches } from "./matching";
import { pickNext } from "./queue";
import type { Attempt, Card, Effort, Prompt, SessionStats, SessionView, Word } from "./types";

export type { Attempt, Card, Effort, Prompt, SessionStats, SessionView, Word };

export type SessionOptions = {
  /** The catalogue. Words without a card are candidates for introduction. */
  words: Word[];
  /** Existing cards for this user. */
  cards: Card[];
  /** Today's new-word ceiling. Controls future workload, so it is never exceeded. */
  newPerDay: number;
  /** New words already introduced today, so a resumed session does not restart. */
  introducedToday?: number;
  /** Emitted per answered prompt, guesses included. Persisting them is the caller's job. */
  onAttempt?: (attempt: Attempt) => void;
  /** Emitted whenever FSRS moves a card. Carries the card to persist. */
  onCardChange?: (card: Card) => void;
  /** Injectable so tests are deterministic and latency is measurable. */
  clock?: () => Date;
  /** Injectable for deterministic ids in tests. */
  newCardId?: () => string;
  scheduler?: FSRS;
};

export type Session = {
  readonly view: SessionView;
  submitGuess(typed: string): void;
  exposureDone(): void;
  submitRecall(typed: string, effort: Effort): void;
  dismissFeedback(): void;
};

type Phase = SessionView["phase"];

type Current = { card: Card; word: Word };

function promptOf(word: Word): Prompt {
  return {
    gloss: word.gloss,
    hint: word.hint,
    image: word.image,
    kind: word.kind,
  };
}

/**
 * The session owns *what happens next*; the component owns *how it looks*.
 *
 * Everything the pipeline decides lives behind this one function: accent-strict
 * comparison, the wrong-is-always-Again rule, guesses being logged but never
 * rated, which effort buttons exist, FSRS, the next-card rule, the daily
 * allowance, and when the session has genuinely run out. None of it is
 * reachable from the UI, so none of it can be got wrong there.
 */
export function createSession(options: SessionOptions): Session {
  const clock = options.clock ?? (() => new Date());
  const newCardId = options.newCardId ?? (() => crypto.randomUUID());
  const scheduler = options.scheduler ?? fsrs({ enable_short_term: true });

  const cards: Card[] = [...options.cards];
  let allowanceLeft = Math.max(0, options.newPerDay - (options.introducedToday ?? 0));

  let phase: Phase = "done";
  let current: Current | null = null;
  let promptShownAt = clock();
  let lastTyped = "";
  let justShownId: string | undefined;
  const stats: SessionStats = { introduced: 0, recalls: 0, correct: 0, wrong: 0 };

  function advance(): void {
    const now = clock();
    const next = pickNext({
      cards,
      words: options.words,
      now,
      allowanceLeft,
      justShownId,
    });

    if (next.kind === "done") {
      current = null;
      phase = "done";
      return;
    }

    if (next.kind === "new") {
      const card: Card = {
        id: newCardId(),
        wordId: next.word.id,
        fsrs: createEmptyCard(now),
      };
      cards.push(card);
      allowanceLeft -= 1;
      stats.introduced += 1;
      // Announced at creation, not at the first rating. The guess attempt is
      // recorded before any rating exists, and attempts.card_id is a foreign key
      // — so a listener that only heard about cards when FSRS moved them would
      // fail to insert the very first attempt of every new word.
      options.onCardChange?.(card);
      current = { card, word: next.word };
      justShownId = card.id;
      // A word never met starts with a guess: retrieval before exposure aids
      // retention even when the guess is wrong, and costs nothing when it is.
      phase = "guess";
      promptShownAt = now;
      return;
    }

    const word = options.words.find((w) => w.id === next.card.wordId);
    if (!word) {
      // A card whose word is missing from the catalogue cannot be shown. Drop it
      // and carry on rather than stranding the session on an unanswerable card.
      const orphan = cards.indexOf(next.card);
      if (orphan >= 0) cards.splice(orphan, 1);
      advance();
      return;
    }

    current = { card: next.card, word };
    justShownId = next.card.id;
    phase = "recall";
    promptShownAt = now;
  }

  function requirePhase(expected: Phase): Current {
    if (phase !== expected) {
      throw new Error(`expected phase "${expected}", session is in "${phase}"`);
    }
    if (!current) throw new Error(`phase "${phase}" with no current card`);
    return current;
  }

  function record(attempt: Attempt): void {
    options.onAttempt?.(attempt);
  }

  advance();

  return {
    get view(): SessionView {
      switch (phase) {
        case "guess":
          return { phase, prompt: promptOf(current!.word) };
        case "exposure":
          return {
            phase,
            prompt: promptOf(current!.word),
            answer: current!.word.text,
          };
        case "recall":
          return {
            phase,
            prompt: promptOf(current!.word),
            efforts: effortsFor(current!.card.fsrs),
          };
        case "feedback":
          return { phase, expected: current!.word.text, typed: lastTyped };
        case "done":
          return { phase, stats: { ...stats } };
      }
    },

    submitGuess(typed: string): void {
      const { card, word } = requirePhase("guess");
      const now = clock();
      // Logged but never rated. Grading every guess Again would start every card
      // at the same stability and destroy the initial-difficulty signal. An
      // empty string is a valid answer — a shrug is a legitimate pretest.
      record({
        cardId: card.id,
        phase: "guess",
        typed,
        correct: matches(typed, word.text),
        rating: null,
        latencyMs: now.getTime() - promptShownAt.getTime(),
        stateBefore: card.fsrs,
        reviewedAt: now,
      });
      phase = "exposure";
    },

    exposureDone(): void {
      requirePhase("exposure");
      phase = "recall";
      promptShownAt = clock();
    },

    submitRecall(typed: string, effort: Effort): void {
      const { card, word } = requirePhase("recall");
      const now = clock();
      const stateBefore = card.fsrs;
      const { correct, rating } = gradeRecall(typed, word.text, effort, effortsFor(stateBefore));

      card.fsrs = scheduler.next(stateBefore, now, rating).card;
      options.onCardChange?.(card);

      record({
        cardId: card.id,
        phase: "recall",
        typed,
        correct,
        rating,
        latencyMs: now.getTime() - promptShownAt.getTime(),
        stateBefore,
        reviewedAt: now,
      });

      stats.recalls += 1;
      if (correct) {
        stats.correct += 1;
        // Nothing to read on a correct answer, so no pause.
        advance();
      } else {
        stats.wrong += 1;
        lastTyped = typed;
        phase = "feedback";
      }
    },

    dismissFeedback(): void {
      requirePhase("feedback");
      advance();
    },
  };
}
