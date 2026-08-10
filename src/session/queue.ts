import { State } from "ts-fsrs";
import type { Card, Word } from "./types";

/**
 * Where a card is in its life.
 *
 * This is the value that used to be implicit. It was spread across `reps`,
 * `state`, `due`, `guessed` and a set of ids held in the session — seven facts
 * in three places with three lifetimes — and every branch below re-derived it
 * from a slightly different subset. All three bugs this module has shipped were
 * two of those derivations disagreeing:
 *
 *   - a card written but never rated, read as a due learning card, so the user
 *     was asked to type a word that had never been shown (daa4fa4)
 *   - an exposure falling through to its own recall, so FSRS's rating #1
 *     measured the short-term buffer rather than the word (e43721e)
 *   - an exposure that changed nothing the rule could see, so on every resumed
 *     sitting the rule handed the same card straight back
 *
 * FSRS cannot own this: it has no opinion about a card it has never rated, since
 * the first rating is its input and not its output. So the stages before that
 * first rating are ours to name, and they are named here, once.
 */
export type Stage =
  /** A card row exists, but no guess was ever logged. Not introduced yet. */
  | "unseen"
  /** Guessed, and waiting for the first rating. FSRS still has no opinion. */
  | "awaiting"
  /** Rated at least once. FSRS owns it from here. */
  | "scheduled";

/** `reps` counts FSRS ratings, and guesses are never rated. */
export function stageOf(card: Card): Stage {
  if (card.fsrs.reps > 0) return "scheduled";
  return card.guessed ? "awaiting" : "unseen";
}

/**
 * What to do next — not which card to show next.
 *
 * The two used to be different questions: this returned a card, and the session
 * separately decided whether that meant an exposure or a recall. The fact the
 * second decision needed lived only in the session, so the rule could not see
 * it, and the two answers drifted. There is one decision now, so there is
 * nothing left to drift.
 */
export type Slot =
  /** `card` is set when resuming an introduction that was abandoned. */
  | { do: "introduce"; word: Word; card?: Card }
  | { do: "expose"; card: Card }
  /** `pulledForward` marks filler: a card shown before it was actually due. */
  | { do: "recall"; card: Card; pulledForward?: true }
  | { do: "done" };

export type Queue = {
  cards: readonly Card[];
  words: readonly Word[];
  now: Date;
  /** Today's remaining new-word ceiling. Never exceeded to fill time. */
  allowanceLeft: number;
  /**
   * Cards whose exposure has already been shown in this sitting.
   *
   * Not persisted, and deliberately so: closing the app loses the knowledge that
   * an exposure was actually read, and re-showing a word costs seconds where
   * skipping it would ask for a word that may never have been seen. It is an
   * input to the rule rather than a fact the caller keeps to itself, because the
   * caller keeping it to itself is what caused the third bug above.
   */
  exposed: ReadonlySet<string>;
  /**
   * Cards already pulled forward once in this sitting.
   *
   * Without this the session cannot end. A card dragged forward is answered,
   * which schedules it a minute out, which is still today — so it is dragged
   * forward again, and again. Never the same card twice running stops the
   * one-card cycle and nothing else: with two cards they simply alternate, and
   * an hour later the session is still going, which is the padding this design
   * exists to refuse.
   *
   * Once is the honest ceiling. A card that genuinely comes due is served by the
   * first rule, which is uncapped and has earned it; a card that has already had
   * its free ride and is still not due is asking for spacing that today cannot
   * give it, and tomorrow can.
   */
  pulledForward: ReadonlySet<string>;
  /**
   * The card answered a moment ago.
   *
   * A minimum-interleave floor of 2 or 3 measured as doing nothing, but that was
   * on sessions of ten cards or more. In the tail, a floor of exactly 1 — never
   * the same card twice running — is what stops the last two cards being handed
   * back and forth, which is massing with extra steps.
   */
  justShownId?: string;
};

type Rule = (q: Queue) => Slot | null;

function isLearning(card: Card): boolean {
  return (
    card.fsrs.state === State.Learning ||
    card.fsrs.state === State.Relearning ||
    // Rated but still New should not happen; showing it beats stranding it.
    card.fsrs.state === State.New
  );
}

function endOfDay(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function earliestDue(cards: readonly Card[]): Card | undefined {
  return cards.reduce<Card | undefined>(
    (best, c) => (!best || c.fsrs.due < best.fsrs.due ? c : best),
    undefined,
  );
}

function at(q: Queue, stage: Stage): Card[] {
  return q.cards.filter((c) => stageOf(c) === stage);
}

/** 1. A rated learning card that is genuinely due. Minute-scale, time-critical. */
const dueLearning: Rule = (q) => {
  const card = earliestDue(at(q, "scheduled").filter((c) => isLearning(c) && c.fsrs.due <= q.now));
  return card ? { do: "recall", card } : null;
};

/**
 * 2. Finish what was started before starting anything else.
 *
 * A card is written the moment a word is introduced, because the guess attempt
 * has a foreign key pointing at it. Quit between the two and the row is left
 * with no rating — which is not a card to schedule, it is a word that has not
 * been introduced. It costs no allowance: that was spent when the row was made.
 */
const unstarted: Rule = (q) => {
  const byDue = at(q, "unseen").sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime());
  for (const card of byDue) {
    const word = q.words.find((w) => w.id === card.wordId);
    if (word) return { do: "introduce", word, card };
  }
  return null;
};

/**
 * 3. A new word, while today's allowance lasts.
 *
 * Before the reviews, so that a new word's second recall lands *inside* the
 * review block — the longest gap the session can give it for free.
 */
const newWord: Rule = (q) => {
  if (q.allowanceLeft <= 0) return null;
  const carded = new Set(q.cards.map((c) => c.wordId));
  const [word] = q.words
    .filter((w) => !carded.has(w.id))
    .sort((a, b) => (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity));
  return word ? { do: "introduce", word } : null;
};

/** 4. A review due today. Day-scale, so the order within the block barely matters. */
const dueReview: Rule = (q) => {
  const eod = endOfDay(q.now);
  const card = earliestDue(
    at(q, "scheduled").filter((c) => c.fsrs.state === State.Review && c.fsrs.due <= eod),
  );
  return card ? { do: "recall", card } : null;
};

/**
 * 5. Show a word that is waiting for its first recall and has not been shown yet
 * in this sitting.
 *
 * Ahead of the recall step, so a batch of resumed words is shown through before
 * any of them is asked for — the same shape a fresh sitting has, where the whole
 * batch is introduced before the first recall.
 */
const needsExposure: Rule = (q) => {
  const card = earliestDue(at(q, "awaiting").filter((c) => !q.exposed.has(c.id)));
  return card ? { do: "expose", card } : null;
};

/**
 * 6. Ask for a word that has been shown.
 *
 * After the reviews, so the gap between seeing a word and producing it is filled
 * with real work rather than an interval we invented. FSRS has no opinion about
 * a card it has never rated, so this placement is ours, and ordering is the
 * honest lever.
 *
 * The card just shown is excluded here and offered again only as the last rule
 * of all, so that anything else at all — including a learning card pulled
 * forward — goes between an exposure and the recall that follows it.
 */
const awaitingRecall: Rule = (q) => {
  const card = earliestDue(
    at(q, "awaiting").filter((c) => q.exposed.has(c.id) && c.id !== q.justShownId),
  );
  return card ? { do: "recall", card } : null;
};

/**
 * 7. A rated learning card due later today. Filler, bounded on purpose.
 *
 * Pulling a card forward five minutes is nearly free. Pulling one forward from
 * three days out discards three days of earned spacing and empties tomorrow,
 * which invites doing it again until the collection drifts toward massing. Anki
 * draws the line in the same place: learn-ahead applies to learning cards, never
 * to mature reviews from future days.
 */
const learnAhead: Rule = (q) => {
  const eod = endOfDay(q.now);
  const card = earliestDue(
    at(q, "scheduled").filter(
      (c) =>
        isLearning(c) && c.fsrs.due <= eod && c.id !== q.justShownId && !q.pulledForward.has(c.id),
    ),
  );
  return card ? { do: "recall", card, pulledForward: true } : null;
};

/**
 * 8. Ask for the word just shown, when there is genuinely nothing else.
 *
 * Producing a word seconds after seeing it is trivial, and the rating it yields
 * is FSRS's first — the one that sets initial difficulty — so every other rule
 * gets to go first, including pulling a learning card forward. That trade is
 * worth making: an early review costs a little stability once, while a rating #1
 * taken from the short-term buffer misprices the card for its whole life.
 *
 * But it has to happen eventually. Refusing outright would show a lone word and
 * then never ask for it — again on the next sitting, and the one after that.
 */
const showAnyway: Rule = (q) => {
  const card = earliestDue(at(q, "awaiting").filter((c) => q.exposed.has(c.id)));
  return card ? { do: "recall", card } : null;
};

/**
 * The next-card rule, in order. The session never waits: a due time is not an
 * appointment, and sitting in front of a timer is not a state this app is
 * allowed to be in. When none of these can offer anything, the session is over —
 * the gap it wanted cannot be filled today, and tomorrow will fill it properly.
 *
 * Precedence is this array. It used to be the order of the branches inside one
 * function, interleaved with the derivations they depended on, which is why the
 * README's numbered list and the code could disagree without anyone noticing.
 */
export const RULE: readonly Rule[] = [
  dueLearning,
  unstarted,
  newWord,
  dueReview,
  needsExposure,
  awaitingRecall,
  learnAhead,
  showAnyway,
];

export function pickNext(queue: Queue): Slot {
  for (const rule of RULE) {
    const slot = rule(queue);
    if (slot) return slot;
  }
  return { do: "done" };
}
