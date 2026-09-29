import { createEmptyCard } from "ts-fsrs";

import { reviveFsrsCard } from "./review-scheduling";
import type { Card } from "./review-scheduling";
import { studyDay } from "./study-day";
import { teachingSchedule } from "./teaching-schedule";

export interface EntryPresentation {
  meaning: string;
  context: string | null;
  grammar: string | null;
  explanation: string | null;
  example: { text: string; translation: string } | null;
}

/** A vocabulary entry shared by stored progress and active sessions. */
export interface Word {
  id: string;
  text: string;
  gloss: string;
  hint: string | null;
  /** Optional teaching material; never part of the recall prompt. */
  revealNote?: string | null;
  presentation?: EntryPresentation;
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

export interface Teaching extends Introduction {
  initialRecallAt: string;
}

/** Serializable input for rebuilding a session in the learner's timezone. */
export interface ReviewSnapshot {
  words: Word[];
  cards: StoredCard[];
  guesses: Introduction[];
  teachings?: Teaching[];
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
  dayRolloverHour = 0,
  teachings: readonly Teaching[] = []
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

  const taught = new Map(
    teachings.map((teaching) => {
      if (!Number.isFinite(new Date(teaching.reviewedAt).getTime())) {
        throw new TypeError(
          `Unreadable teaching time for word ${teaching.wordId}.`
        );
      }
      // Validate the persisted due time even if a rated card now supersedes it.
      teachingSchedule(teaching.initialRecallAt);
      return [teaching.wordId, teaching] as const;
    })
  );
  // Historical guesses retain their original allowance charge.
  const introductionsByWord = new Map([...taught, ...guesses]);

  return {
    cards: [
      ...storedCards.map((stored) => {
        const card = toCard(stored);
        const teaching = taught.get(card.wordId);
        if (card.fsrs.reps === 0 && teaching) {
          return {
            ...toCard({
              schedule: teachingSchedule(teaching.initialRecallAt),
              wordId: card.wordId,
            }),
            initialRecallAt: teaching.initialRecallAt,
          };
        }
        return card;
      }),
      ...[...taught.values()]
        .filter((teaching) => !carded.has(teaching.wordId))
        .map((teaching) => ({
          ...toCard({
            schedule: teachingSchedule(teaching.initialRecallAt),
            wordId: teaching.wordId,
          }),
          initialRecallAt: teaching.initialRecallAt,
        })),
      // A guess with no card row is a word waiting for its first rating: the
      // "awaiting" stage, rebuilt from the attempt that defines it. Seeded at
      // the guess time so the exposure rule shows them in introduction order.
      ...[...guesses.values()]
        .filter((g) => !carded.has(g.wordId) && !taught.has(g.wordId))
        .map((g) => ({
          fsrs: createEmptyCard(new Date(g.reviewedAt)),
          wordId: g.wordId,
        })),
    ],
    // Durable introductions survive reopening and card deletion. A legacy
    // guess takes precedence over its later teaching to avoid a second charge.
    introducedToday: [...introductionsByWord.values()].filter((g) => {
      const at = new Date(g.reviewedAt);
      return at >= start && at < nextStart;
    }).length,
    words: [...words],
  };
};
