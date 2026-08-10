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
  /** Both passed to the rule rather than kept here — see `Queue.exposed`. */
  const exposedThisSession = new Set<string>();
  const pulledForwardThisSession = new Set<string>();
  const stats: SessionStats = { introduced: 0, recalls: 0, correct: 0, wrong: 0 };

  /** The word a card points at, or undefined if it has left the catalogue. */
  function wordFor(card: Card): Word | undefined {
    return options.words.find((w) => w.id === card.wordId);
  }

  function advance(): void {
    const now = clock();

    // A card whose word is no longer in the catalogue cannot be shown. Dropping
    // them up front means the rule below only ever sees showable cards, so there
    // is no unshowable answer to recover from afterwards.
    for (let i = cards.length - 1; i >= 0; i--) {
      if (!wordFor(cards[i]!)) cards.splice(i, 1);
    }

    const slot = pickNext({
      cards,
      words: options.words,
      now,
      allowanceLeft,
      exposed: exposedThisSession,
      pulledForward: pulledForwardThisSession,
      justShownId,
    });

    promptShownAt = now;

    switch (slot.do) {
      case "done":
        current = null;
        phase = "done";
        return;

      case "introduce": {
        // Reuse the row when resuming an abandoned introduction. Creating a
        // second card for the same word would be rejected by
        // unique(user_id, word_id, card_type), and the allowance was already
        // spent when the first one was made.
        const resuming = slot.card !== undefined;
        const card: Card = slot.card ?? {
          id: newCardId(),
          wordId: slot.word.id,
          fsrs: createEmptyCard(now),
          guessed: false,
        };

        if (!resuming) {
          cards.push(card);
          allowanceLeft -= 1;
          // Announced at creation, not at the first rating. The guess attempt is
          // recorded before any rating exists, and attempts.card_id is a foreign
          // key — so a listener that only heard about cards when FSRS moved them
          // would fail to insert the very first attempt of every new word.
          options.onCardChange?.(card);
        }

        // A resumed introduction counts too: it is a word met for the first time
        // in this sitting, which is what the number on the end screen means. It
        // can exceed the allowance only by resuming a card abandoned on an
        // earlier day, where the larger number is the honest one.
        stats.introduced += 1;
        current = { card, word: slot.word };
        justShownId = card.id;
        // A word never met starts with a guess: retrieval before exposure aids
        // retention even when the guess is wrong, and costs nothing when it is.
        phase = "guess";
        return;
      }

      case "expose":
      case "recall": {
        if (slot.do === "recall" && slot.pulledForward) {
          pulledForwardThisSession.add(slot.card.id);
        }
        current = { card: slot.card, word: wordFor(slot.card)! };
        justShownId = slot.card.id;
        phase = slot.do === "expose" ? "exposure" : "recall";
        return;
      }
    }
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

  /**
   * How long the prompt was on screen, within reason.
   *
   * `attempts.latency_ms` is an `integer`, so a tab left open for a month
   * overflows it and Postgres rejects the whole row — losing the answer itself
   * over a number that is only ever read for analysis. A clock that steps
   * backwards, which phones do, would send a negative one. Neither is a real
   * measurement, and neither is worth losing a rep over.
   */
  function latencySince(shownAt: Date, now: Date): number {
    const A_DAY = 24 * 60 * 60_000;
    return Math.min(Math.max(0, now.getTime() - shownAt.getTime()), A_DAY);
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
        latencyMs: latencySince(promptShownAt, now),
        stateBefore: card.fsrs,
        reviewedAt: now,
      });
      card.guessed = true;
      phase = "exposure";
    },

    exposureDone(): void {
      const { card } = requirePhase("exposure");
      exposedThisSession.add(card.id);
      // Back to the queue rather than straight to recall. Producing a word two
      // seconds after being shown it is trivial, so the rating it yields — which
      // is FSRS's first, the one that sets initial difficulty — would measure
      // short-term memory rather than the word. The next-card rule puts real
      // work in between instead.
      advance();
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
        latencyMs: latencySince(promptShownAt, now),
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
