import { createEmptyCard } from "ts-fsrs";

import { reviveFsrsCard } from "./review-scheduling";
import type { Card } from "./review-scheduling";
import { studyDay } from "./study-day";

/** A vocabulary entry shared by stored progress and active sessions. */
export interface Word {
  id: string;
  text: string;
  gloss: string;
  hint: string | null;
  image: string | null;
  kind: "word" | "chunk";
  freqRank: number | null;
}

/** Storage-neutral progress. Only this package interprets the opaque schedule. */
export interface StoredCard {
  wordId: string;
  schedule: string;
}
export interface Introduction {
  wordId: string;
  reviewedAt: string;
}

/** Serializable input for rebuilding a session in the learner's timezone. */
export interface ReviewSnapshot {
  words: Word[];
  cards: StoredCard[];
  guesses: Introduction[];
}

export const toCard = (card: StoredCard): Card => {
  let raw: unknown;
  try {
    raw = JSON.parse(card.schedule);
  } catch (error) {
    throw new Error(
      `Unreadable scheduling state for card ${card.wordId}: invalid JSON`,
      { cause: error }
    );
  }
  return { fsrs: reviveFsrsCard(raw, card.wordId), wordId: card.wordId };
};

export interface RestoredProgress {
  words: Word[];
  cards: Card[];
  introducedToday: number;
}

/**
 * Restore awaiting cards and the local study-day allowance from saved progress.
 * Introductions are unique per word; deduplicating overlapping inputs by word
 * is exact rather than lossy. This reconstruction owns no storage or queries.
 */
export const restoreProgress = (
  words: readonly Word[],
  storedCards: readonly StoredCard[],
  introductions: readonly Introduction[],
  now: Date,
  dayRolloverHour = 0
): RestoredProgress => {
  const { start, nextStart } = studyDay(now, dayRolloverHour);
  const carded = new Set(storedCards.map((card) => card.wordId));
  const guesses = new Map(
    introductions.map((guess) => {
      if (!Number.isFinite(new Date(guess.reviewedAt).getTime())) {
        // oxlint-disable-next-line unicorn/prefer-type-error -- Preserve the existing Error category for invalid stored timestamps.
        throw new Error(
          `Unreadable introduction time for word ${guess.wordId}.`
        );
      }
      return [guess.wordId, guess] as const;
    })
  );

  return {
    cards: [
      ...storedCards.map(toCard),
      // A guess with no card row is a word waiting for its first rating: the
      // "awaiting" stage, rebuilt from the attempt that defines it. Seeded at
      // the guess time so the exposure rule shows them in introduction order.
      ...[...guesses.values()]
        .filter((g) => !carded.has(g.wordId))
        .map((g) => ({
          fsrs: createEmptyCard(new Date(g.reviewedAt)),
          wordId: g.wordId,
        })),
    ],
    // Counted from the guesses rather than tracked separately, so reopening
    // the app mid-day resumes the allowance instead of restarting it. Guesses
    // are append-only, so not even deleting cards can refund a spent slot.
    introducedToday: [...guesses.values()].filter((g) => {
      const at = new Date(g.reviewedAt);
      return at >= start && at < nextStart;
    }).length,
    words: [...words],
  };
};
