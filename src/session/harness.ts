/**
 * A learner who closes the app and comes back. Test-only; nothing imports it
 * from the app.
 *
 * Every other test in this module builds its starting cards by hand, and a
 * hand-built fixture can only contain the states someone already thought of —
 * which is exactly the set with no bugs in it. Every bug this module has had was
 * a state nobody thought of: a card written but never rated, a word guessed but
 * never recalled, an exposure the queue could not see.
 *
 * So this harness never writes a card. It runs a sitting, keeps whatever the
 * session emitted, pushes it through the same JSON round trip `jsonb` does, and
 * rebuilds the next sitting's deck with the same `buildDeck` the app uses. The
 * states it visits are the states production visits, including the ones we would
 * not have thought to write down.
 */

import { buildDeck } from "../lib/repository";
import type { CardRow, WordRow } from "../lib/repository";
import { createSession } from "./index";
import type { Attempt, Effort, Word } from "./types";

/** One prompt the session put on screen, and which card it was about. */
export type Step =
  | { at: "guess"; card: string; word: string }
  | { at: "exposure"; card: string; word: string }
  /** `first` marks FSRS's rating #1 — the one that sets initial difficulty. */
  | { at: "recall"; card: string; word: string; first: boolean }
  | { at: "feedback"; card: string; word: string }
  /** The app was closed. Everything after this came from a fresh load. */
  | { at: "closed" };

export type Behaviour = {
  /** Whether this recall is answered correctly. Defaults to always. */
  correct?: (word: Word, recallNumber: number) => boolean;
  /** Which grade button is pressed on a correct answer. Defaults to Good. */
  effort?: (word: Word) => Effort;
  /** How long each prompt takes. Defaults to the measured ~18s. */
  msPerPrompt?: number;
};

export type Learner = {
  /**
   * Open the app, answer up to `maxSteps` prompts, then close it. Returns the
   * steps of this sitting; `trace` accumulates them across sittings.
   *
   * Called with no argument it answers until the session says it is done, and
   * throws if that never happens — a session that cannot end is a bug, and a
   * test that hangs reports it far less usefully than one that fails.
   */
  sit(maxSteps?: number): Step[];
  /** Move the clock on without answering anything. */
  wait(ms: number): void;
  readonly now: Date;
  readonly trace: readonly Step[];
  readonly attempts: readonly Attempt[];
  /** Card ids in creation order, as the database holds them. */
  readonly cardIds: readonly string[];
  /** Cards created since local midnight, which is what spends the allowance. */
  readonly introducedToday: number;
};

function toWordRow(w: Word): WordRow {
  return {
    id: w.id,
    text: w.text,
    gloss: w.gloss,
    hint: w.hint,
    image: w.image,
    kind: w.kind,
    freq_rank: w.freqRank,
  };
}

export function createLearner(options: {
  words: Word[];
  newPerDay: number;
  start: Date;
  behaviour?: Behaviour;
}): Learner {
  const { words, newPerDay, start } = options;
  const correct = options.behaviour?.correct ?? (() => true);
  const effort = options.behaviour?.effort ?? (() => "good" as const);
  const msPerPrompt = options.behaviour?.msPerPrompt ?? 18_000;

  // The harness identifies a card from what is on screen, so the catalogue has
  // to be unambiguous. A duplicate would make a passing test meaningless.
  const byGloss = new Map<string, Word>();
  const byText = new Map<string, Word>();
  for (const w of words) {
    if (byGloss.has(w.gloss)) throw new Error(`two words share the gloss "${w.gloss}"`);
    if (byText.has(w.text)) throw new Error(`two words share the text "${w.text}"`);
    byGloss.set(w.gloss, w);
    byText.set(w.text, w);
  }

  const wordRows = words.map(toWordRow);
  /** The `cards` table: insertion-ordered, values as jsonb would hold them. */
  const cardRows = new Map<string, CardRow>();
  /** The `attempts` table: append-only, exactly like the real one. */
  const attempts: Attempt[] = [];
  const trace: Step[] = [];
  /** How many recalls each card has had, so `behaviour.correct` can vary. */
  const recallCount = new Map<string, number>();

  let nowMs = start.getTime();
  let seq = 0;

  function cardIdFor(wordId: string): string {
    for (const row of cardRows.values()) if (row.word_id === wordId) return row.id;
    throw new Error(`no card for word ${wordId} — the session showed it before writing it`);
  }

  /** Far past any real sitting: 15 new words is about 28 answers. */
  const NEVER_ENDS = 5_000;

  function sit(maxSteps?: number): Step[] {
    const deck = buildDeck(
      wordRows,
      [...cardRows.values()],
      attempts.filter((a) => a.phase === "guess").map((a) => a.cardId),
      new Date(nowMs),
    );

    const session = createSession({
      words: deck.words,
      cards: deck.cards,
      newPerDay,
      introducedToday: deck.introducedToday,
      clock: () => new Date(nowMs),
      newCardId: () => `card-${++seq}`,
      onCardChange: (card) => {
        cardRows.set(card.id, {
          id: card.id,
          word_id: card.wordId,
          // Through JSON, because `fsrs_state` is jsonb and that is where the
          // Date objects are lost.
          fsrs_state: JSON.parse(JSON.stringify(card.fsrs)) as unknown,
          created_at: cardRows.get(card.id)?.created_at ?? new Date(nowMs).toISOString(),
        });
      },
      onAttempt: (attempt) => attempts.push(attempt),
    });

    const limit = maxSteps ?? NEVER_ENDS;
    const steps: Step[] = [];
    let finished = false;

    for (let i = 0; i < limit; i++) {
      const view = session.view;
      if (view.phase === "done") {
        finished = true;
        break;
      }

      if (view.phase === "guess") {
        const word = byGloss.get(view.prompt.gloss)!;
        steps.push({ at: "guess", card: cardIdFor(word.id), word: word.text });
        session.submitGuess("");
      } else if (view.phase === "exposure") {
        const word = byText.get(view.answer)!;
        steps.push({ at: "exposure", card: cardIdFor(word.id), word: word.text });
        session.exposureDone();
      } else if (view.phase === "recall") {
        const word = byGloss.get(view.prompt.gloss)!;
        const card = cardIdFor(word.id);
        const n = (recallCount.get(card) ?? 0) + 1;
        recallCount.set(card, n);
        const right = correct(word, n);
        steps.push({
          at: "recall",
          card,
          word: word.text,
          first: attempts.every((a) => !(a.cardId === card && a.phase === "recall")),
        });
        session.submitRecall(right ? word.text : `${word.text}-sbagliato`, effort(word));
      } else {
        const word = byText.get(view.expected)!;
        steps.push({ at: "feedback", card: cardIdFor(word.id), word: word.text });
        session.dismissFeedback();
      }

      nowMs += msPerPrompt;
    }

    if (maxSteps === undefined && !finished) {
      throw new Error(`session was still going after ${NEVER_ENDS} prompts`);
    }

    steps.push({ at: "closed" });
    trace.push(...steps);
    return steps;
  }

  return {
    sit,
    wait: (ms) => {
      nowMs += ms;
    },
    get now() {
      return new Date(nowMs);
    },
    get trace() {
      return trace;
    },
    get attempts() {
      return attempts;
    },
    get cardIds() {
      return [...cardRows.keys()];
    },
    get introducedToday() {
      return buildDeck(wordRows, [...cardRows.values()], [], new Date(nowMs)).introducedToday;
    },
  };
}

/** A catalogue of `n` distinct words, frequency-ordered. */
export function catalogue(n: number): Word[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `w${i}`,
    text: `mot${i}`,
    gloss: `parola${i}`,
    hint: null,
    image: null,
    kind: "word" as const,
    freqRank: i,
  }));
}
