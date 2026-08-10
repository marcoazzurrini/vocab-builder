import { State } from "ts-fsrs";
import type { Card, Word } from "./types";

/**
 * The next-card rule. The session never waits: a due time is not an
 * appointment, and sitting in front of a timer is not a state this app is
 * allowed to be in.
 *
 *   1. A learning card that is actually due       — minute-scale, time-critical
 *   2. A new word, while today's allowance lasts
 *   3. A review due today                         — day-scale, order barely matters
 *   4. A learning card due later today, early     — filler, bounded on purpose
 *   5. Nothing → the session is over
 *
 * New words come before reviews so that their second recall lands *inside* the
 * review block, which is the longest gap the session can offer them for free.
 *
 * Step 4 is deliberately limited to cards still in their learning steps.
 * Pulling forward a card due in five minutes is nearly free; pulling one
 * forward from three days out discards three days of earned spacing and empties
 * tomorrow, which invites doing it again until the collection drifts toward
 * massing. Anki draws the line in the same place.
 */
export type Next =
  | { kind: "card"; card: Card; pulledForward: boolean }
  | { kind: "new"; word: Word }
  | { kind: "done" };

/** New cards count as learning: they are mid-introduction, not scheduled. */
function isLearning(card: Card): boolean {
  return (
    card.fsrs.state === State.New ||
    card.fsrs.state === State.Learning ||
    card.fsrs.state === State.Relearning
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
   * The card answered a moment ago. Excluded from step 4 only.
   *
   * The spike measured a minimum-interleave floor as doing nothing, but that
   * was on sessions of ten cards or more. With two or three cards left, step 4
   * will happily hand back the card just answered, which is massing with extra
   * steps. Ending the session is the better outcome: the gap it wanted cannot
   * be filled, and tomorrow will fill it properly.
   */
  justShownId?: string;
}): Next {
  const eod = endOfDay(now);

  const learningDue = earliestDue(cards.filter((c) => isLearning(c) && c.fsrs.due <= now));
  if (learningDue) return { kind: "card", card: learningDue, pulledForward: false };

  if (allowanceLeft > 0) {
    const carded = new Set(cards.map((c) => c.wordId));
    const fresh = words
      .filter((w) => !carded.has(w.id))
      .sort((a, b) => (a.freqRank ?? Infinity) - (b.freqRank ?? Infinity));
    if (fresh[0]) return { kind: "new", word: fresh[0] };
  }

  const reviewDue = earliestDue(
    cards.filter((c) => c.fsrs.state === State.Review && c.fsrs.due <= eod),
  );
  if (reviewDue) return { kind: "card", card: reviewDue, pulledForward: false };

  const learningToday = earliestDue(
    cards.filter((c) => isLearning(c) && c.fsrs.due <= eod && c.id !== justShownId),
  );
  if (learningToday) return { kind: "card", card: learningToday, pulledForward: true };

  return { kind: "done" };
}
