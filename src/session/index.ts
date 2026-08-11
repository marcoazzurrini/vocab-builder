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
  /**
   * Wrong recalls per word since the day rolled over, so a resumed session
   * does not reset the parking counter. Same shape as `introducedToday`: the
   * day's history, read back in.
   */
  failedToday?: ReadonlyMap<string, number>;
  /** All recalls per word since the day rolled over, for the Hard-loop bound. */
  recalledToday?: ReadonlyMap<string, number>;
  /** The hour the study day rolls over. Midnight unless told otherwise. */
  dayRolloverHour?: number;
  /** Emitted per answered prompt, guesses included. Persisting them is the caller's job. */
  onAttempt?: (attempt: Attempt) => void;
  /**
   * Emitted whenever FSRS moves a card — which includes the first rating, the
   * moment the card row is born. Nothing is announced before that: attempts
   * are keyed by word, so the guess needs no row to point at.
   */
  onCardChange?: (card: Card) => void;
  /** Injectable so tests are deterministic and latency is measurable. */
  clock?: () => Date;
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

/**
 * After this many wrong recalls in one study day, a word is parked until
 * tomorrow. `Again` schedules a failed card a minute out, so a word that will
 * not come today keeps genuinely coming due — and a bad day on three words was
 * a session with no end. Parking is a visibility rule, not a scheduling one:
 * the attempt is recorded and FSRS rates it, the card simply stops being
 * offered for the rest of the day. Tomorrow returns it on its own, so there is
 * no management UI to build and nothing to unsuspend.
 */
export const PARK_AFTER = 8;

/**
 * The same door, for a different pathology: a card answered correctly but
 * rated Hard every time never leaves its learning step — ts-fsrs holds it at
 * a fixed six-minute interval forever, measured, so a slow-paced always-Hard
 * learner loops it all day and the failure counter never moves, since nothing
 * failed. Twice the failure threshold is unreachable by any normal day — a
 * word failed seven times and still progressing stays well under it — so the
 * only sessions this ends are the ones that otherwise would not.
 */
export const PARK_AFTER_RECALLS = PARK_AFTER * 2;

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
  const scheduler = options.scheduler ?? fsrs({ enable_short_term: true });

  const cards: Card[] = [...options.cards];
  let allowanceLeft = Math.max(0, options.newPerDay - (options.introducedToday ?? 0));
  /** Wrong recalls per word today, seeded from history so reopening cannot reset it. */
  const failures = new Map(options.failedToday ?? []);
  /** All recalls per word today, for the same reason. */
  const recallsToday = new Map(options.recalledToday ?? []);

  let phase: Phase = "done";
  let current: Current | null = null;
  let promptShownAt = clock();
  let lastTyped = "";
  let justShownId: string | undefined;
  /** Both passed to the rule rather than kept here — see `Queue.exposed`. */
  const exposedThisSession = new Set<string>();
  const pulledForwardThisSession = new Set<string>();
  const stats: SessionStats = { introduced: 0, recalls: 0, correct: 0, wrong: 0 };

  const wordById = new Map(options.words.map((w) => [w.id, w]));

  /** The word a card points at, or undefined if it has left the catalogue. */
  function wordFor(card: Card): Word | undefined {
    return wordById.get(card.wordId);
  }

  function advance(): void {
    const now = clock();

    // A card whose word is no longer in the catalogue cannot be shown. Dropping
    // them up front means the rule below only ever sees showable cards, so there
    // is no unshowable answer to recover from afterwards.
    for (let i = cards.length - 1; i >= 0; i--) {
      if (!wordFor(cards[i]!)) cards.splice(i, 1);
    }

    // The card itself is untouched by parking: recorded, rated, and back
    // tomorrow when the counters read zero again. Only the rule stops seeing
    // it — see Queue.parked for why the rule, and not a filter here.
    const parked = new Set(
      cards
        .map((c) => c.wordId)
        .filter(
          (w) =>
            (failures.get(w) ?? 0) >= PARK_AFTER ||
            (recallsToday.get(w) ?? 0) >= PARK_AFTER_RECALLS,
        ),
    );

    const slot = pickNext({
      cards,
      words: options.words,
      now,
      allowanceLeft,
      exposed: exposedThisSession,
      pulledForward: pulledForwardThisSession,
      justShownId,
      parked,
      dayRolloverHour: options.dayRolloverHour,
    });

    promptShownAt = now;

    switch (slot.do) {
      case "done":
        current = null;
        phase = "done";
        return;

      case "introduce": {
        // Nothing is pushed or spent yet: the word only becomes real at the
        // guess. Abandon this screen and no trace remains anywhere — which is
        // the truth of what happened.
        current = { card: { wordId: slot.word.id, fsrs: createEmptyCard(now) }, word: slot.word };
        justShownId = slot.word.id;
        // A word never met starts with a guess: retrieval before exposure aids
        // retention even when the guess is wrong, and costs nothing when it is.
        phase = "guess";
        return;
      }

      case "expose":
      case "recall": {
        if (slot.do === "recall" && slot.pulledForward) {
          pulledForwardThisSession.add(slot.card.wordId);
        }
        current = { card: slot.card, word: wordFor(slot.card)! };
        justShownId = slot.card.wordId;
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
        wordId: card.wordId,
        phase: "guess",
        typed,
        correct: matches(typed, word.text),
        rating: null,
        latencyMs: latencySince(promptShownAt, now),
        stateBefore: card.fsrs,
        reviewedAt: now,
      });
      // The guess is the moment the word becomes real: the attempt is on
      // record, so the card joins the deck and the allowance is spent — not at
      // the introduce slot, where abandoning would have left a ghost.
      cards.push(card);
      allowanceLeft -= 1;
      stats.introduced += 1;
      phase = "exposure";
    },

    exposureDone(): void {
      const { card } = requirePhase("exposure");
      exposedThisSession.add(card.wordId);
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
        wordId: card.wordId,
        phase: "recall",
        typed,
        correct,
        rating,
        latencyMs: latencySince(promptShownAt, now),
        stateBefore,
        reviewedAt: now,
      });

      stats.recalls += 1;
      recallsToday.set(card.wordId, (recallsToday.get(card.wordId) ?? 0) + 1);
      if (correct) {
        stats.correct += 1;
        // Nothing to read on a correct answer, so no pause.
        advance();
      } else {
        stats.wrong += 1;
        failures.set(card.wordId, (failures.get(card.wordId) ?? 0) + 1);
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
