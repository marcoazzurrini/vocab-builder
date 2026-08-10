import { State } from "ts-fsrs";
import type { Card, Word } from "./types";

/**
 * The next-card rule. The session never waits: a due time is not an
 * appointment, and sitting in front of a timer is not a state this app is
 * allowed to be in.
 *
 *   1. A rated learning card that is actually due  — minute-scale, time-critical
 *   2. A word introduced but never guessed         — see "unrated cards" below
 *   3. A new word, while today's allowance lasts
 *   4. A review due today                          — day-scale, order barely matters
 *   5. A word waiting for its first recall
 *   6. A rated learning card due later today       — filler, bounded on purpose
 *   7. Nothing → the session is over
 *
 * New words come before reviews so that their second recall lands *inside* the
 * review block, which is the longest gap the session can offer them for free.
 *
 * Step 5 is deliberately limited to cards still in their learning steps.
 * Pulling forward a card due in five minutes is nearly free; pulling one
 * forward from three days out discards three days of earned spacing and empties
 * tomorrow, which invites doing it again until the collection drifts toward
 * massing. Anki draws the line in the same place.
 *
 *
 * UNRATED CARDS
 *
 * A card is written the moment a word is introduced, because the guess attempt
 * has to reference it. So "a card exists" and "the word has been introduced"
 * are not the same thing: quit between the two and a card is left behind with
 * no rating at all.
 *
 * Such a card is not something to schedule — it is a word that has not been
 * introduced yet. Treating it as schedulable is what once asked the user to
 * type a word they had never been shown, since every scheduled card goes
 * straight to recall. It is excluded from every scheduling branch here, and
 * step 2 hands it back to the introduction path instead, reusing the existing
 * row rather than creating a second one that unique(user_id, word_id,
 * card_type) would reject.
 */
export type Next =
  | { kind: "card"; card: Card; pulledForward: boolean }
  /** `existing` is set when resuming an introduction that was abandoned. */
  | { kind: "introduce"; word: Word; existing?: Card }
  | { kind: "done" };

/** reps counts FSRS ratings, and guesses are never rated. */
function isRated(card: Card): boolean {
  return card.fsrs.reps > 0;
}

function isLearning(card: Card): boolean {
  return (
    card.fsrs.state === State.Learning ||
    card.fsrs.state === State.Relearning ||
    card.fsrs.state === State.New
  );
}

function endOfDay(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

function earliestDue(cards: Card[]): Card | undefined {
  return cards.reduce<Card | undefined>(
    (best, c) => (!best || c.fsrs.due < best.fsrs.due ? c : best),
    undefined,
  );
}

function byFrequency(a: Word, b: Word): number {
  return (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity);
}

export function pickNext({
  cards,
  words,
  now,
  allowanceLeft,
  justShownId,
}: {
  cards: Card[];
  words: Word[];
  now: Date;
  allowanceLeft: number;
  /**
   * The card answered a moment ago. Excluded from step 5 only.
   *
   * A minimum-interleave floor of 2 or 3 measured as doing nothing, but that
   * was on sessions of ten cards or more. With two or three cards left, step 5
   * will happily hand back the card just answered, which is massing with extra
   * steps. Ending the session is the better outcome: the gap it wanted cannot
   * be filled, and tomorrow will fill it properly.
   */
  justShownId?: string;
}): Next {
  const eod = endOfDay(now);
  const rated = cards.filter(isRated);

  const learningDue = earliestDue(rated.filter((c) => isLearning(c) && c.fsrs.due <= now));
  if (learningDue) return { kind: "card", card: learningDue, pulledForward: false };

  // Finish what was started before starting anything else, and without
  // spending allowance — this word was already counted when its card was made.
  // Not yet guessed: this word has not been introduced at all.
  const unstarted = cards.filter((c) => !isRated(c) && !c.guessed);
  for (const card of unstarted.sort((a, b) => a.fsrs.due.getTime() - b.fsrs.due.getTime())) {
    const word = words.find((w) => w.id === card.wordId);
    if (word) return { kind: "introduce", word, existing: card };
  }

  if (allowanceLeft > 0) {
    const carded = new Set(cards.map((c) => c.wordId));
    const fresh = words.filter((w) => !carded.has(w.id)).sort(byFrequency);
    if (fresh[0]) return { kind: "introduce", word: fresh[0] };
  }

  const reviewDue = earliestDue(
    rated.filter((c) => c.fsrs.state === State.Review && c.fsrs.due <= eod),
  );
  if (reviewDue) return { kind: "card", card: reviewDue, pulledForward: false };

  // Guessed and shown, waiting for its first rating. Placed after the reviews so
  // the gap between seeing a word and producing it is filled with real work
  // rather than an interval we invented — FSRS has no opinion about a card it
  // has never rated, so the placement is ours, and ordering is the honest lever.
  // justShownId is deliberately NOT applied here. An exposure is not an answer,
  // so coming straight back to the same card is correct when nothing else is
  // available — excluding it would expose a lone new word and then never ask
  // for it.
  const awaitingFirstRecall = earliestDue(cards.filter((c) => !isRated(c) && c.guessed));
  if (awaitingFirstRecall) {
    return { kind: "card", card: awaitingFirstRecall, pulledForward: false };
  }

  const learningToday = earliestDue(
    rated.filter((c) => isLearning(c) && c.fsrs.due <= eod && c.id !== justShownId),
  );
  if (learningToday) return { kind: "card", card: learningToday, pulledForward: true };

  return { kind: "done" };
}
