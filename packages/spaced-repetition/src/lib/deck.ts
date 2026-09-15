import { createEmptyCard, State } from "ts-fsrs";
import type { Card as FsrsCard } from "ts-fsrs";
import * as v from "valibot";
import type { Card, Word } from "../session/types";
import { studyDay } from "./day";

/** Storage-neutral progress. Only this package interprets the opaque schedule. */
export type StoredCard = { wordId: string; schedule: string };
export type Introduction = { wordId: string; reviewedAt: string };

/** Serializable input for rebuilding a session in the learner's timezone. */
export type ReviewSnapshot = {
  words: Word[];
  cards: StoredCard[];
  guesses: Introduction[];
};

/** A date as JSON returns it: an ISO string, or a Date if it never left. */
const StoredDate = v.pipe(
  v.union([v.string(), v.date()]),
  v.transform((value) => new Date(value)),
  v.check((date) => !Number.isNaN(date.getTime()), "unparseable date"),
);

/**
 * What `cards.fsrs_state` is allowed to contain.
 *
 * Checked rather than cast. The cast that used to be here was the one place the
 * app took the database at its word, and the failure it allowed is silent: a
 * `due` that is a string rather than a Date makes ts-fsrs do arithmetic on a
 * string, which produces a schedule that is wrong without ever raising
 * anything — the worst kind of bug in a system whose whole job is deciding when
 * you next see a word. The same argument that justified reviving the dates
 * justifies checking that they arrived.
 *
 * `learning_steps` carries a default because ts-fsrs added it after some rows
 * were written; step 0 is where a card without one belongs.
 *
 * Loose on purpose: this shape belongs to ts-fsrs, not to us, and a plain
 * `v.object` strips the keys it does not know — so the next field upstream
 * adds would be silently deleted on every load, which is precisely the silent
 * mis-scheduling this validator exists to prevent. Known fields are checked;
 * unknown ones pass through untouched.
 */
const FsrsState = v.looseObject({
  due: StoredDate,
  stability: v.number(),
  difficulty: v.number(),
  elapsed_days: v.number(),
  scheduled_days: v.number(),
  learning_steps: v.optional(v.number(), 0),
  reps: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lapses: v.pipe(v.number(), v.integer(), v.minValue(0)),
  state: v.picklist([State.New, State.Learning, State.Review, State.Relearning]),
  last_review: v.optional(StoredDate),
});

/**
 * Rebuild the Date objects JSON threw away, refusing anything else.
 *
 * Loud rather than lenient: a card is a derived cache and can be rebuilt from
 * `attempts`, so unreadable scheduling state is a repairable problem — but only
 * if someone is told about it. Skipping the row instead would make the word look
 * uncarded, and re-introducing it would collide with the card already there.
 */
export function reviveFsrsCard(raw: unknown, cardId?: string): FsrsCard {
  const result = v.safeParse(FsrsState, raw);
  if (!result.success) {
    const where = cardId ? ` for card ${cardId}` : "";
    throw new Error(`Unreadable scheduling state${where}: ${v.summarize(result.issues)}`);
  }
  return result.output;
}

export function toCard(card: StoredCard): Card {
  let raw: unknown;
  try {
    raw = JSON.parse(card.schedule);
  } catch (cause) {
    throw new Error(`Unreadable scheduling state for card ${card.wordId}: invalid JSON`, { cause });
  }
  return { wordId: card.wordId, fsrs: reviveFsrsCard(raw, card.wordId) };
}

export type Deck = {
  words: Word[];
  cards: Card[];
  introducedToday: number;
};

export type Settings = {
  lang: string;
  newPerDay: number;
  dayRolloverHour: number;
};

/** Mirrors the column defaults, for a user who has never written a row. */
export const DEFAULT_SETTINGS: Settings = { lang: "fr", newPerDay: 15, dayRolloverHour: 4 };

/**
 * Everything `loadDeck` does except the queries.
 *
 * Pure reconstruction of awaiting cards and the local study-day allowance.
 * Both the client and the session harness use this function without importing
 * database clients, server functions, or credentials.
 *
 * The schema guarantees one guess per word; deduplicating overlapping inputs
 * by word is exact rather than lossy.
 */
export function buildDeck(
  words: readonly Word[],
  storedCards: readonly StoredCard[],
  introductions: readonly Introduction[],
  now: Date,
  dayRolloverHour = 0,
): Deck {
  const { start, nextStart } = studyDay(now, dayRolloverHour);
  const carded = new Set(storedCards.map((card) => card.wordId));
  const guesses = new Map(
    introductions.map((guess) => {
      if (!Number.isFinite(new Date(guess.reviewedAt).getTime()))
        throw new Error(`Unreadable introduction time for word ${guess.wordId}.`);
      return [guess.wordId, guess] as const;
    }),
  );

  return {
    words: [...words],
    cards: [
      ...storedCards.map(toCard),
      // A guess with no card row is a word waiting for its first rating: the
      // "awaiting" stage, rebuilt from the attempt that defines it. Seeded at
      // the guess time so the exposure rule shows them in introduction order.
      ...[...guesses.values()]
        .filter((g) => !carded.has(g.wordId))
        .map((g) => ({ wordId: g.wordId, fsrs: createEmptyCard(new Date(g.reviewedAt)) })),
    ],
    // Counted from the guesses rather than tracked separately, so reopening
    // the app mid-day resumes the allowance instead of restarting it. Guesses
    // are append-only, so not even deleting cards can refund a spent slot.
    introducedToday: [...guesses.values()].filter((g) => {
      const at = new Date(g.reviewedAt);
      return at >= start && at < nextStart;
    }).length,
  };
}
