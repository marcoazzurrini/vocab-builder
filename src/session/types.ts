import type { Card as FsrsCard, Grade } from "ts-fsrs";

/** A row from `words`. The catalogue, shared and read-only. */
export type Word = {
  id: string;
  text: string;
  gloss: string;
  hint: string | null;
  image: string | null;
  kind: "word" | "chunk";
  freqRank: number | null;
};

/** A row from `cards`: one word's scheduling state for one user. */
export type Card = {
  id: string;
  wordId: string;
  fsrs: FsrsCard;
  /**
   * Whether a guess has ever been logged for this card, read from `attempts`.
   *
   * Guesses are never rated, so FSRS state cannot tell "never introduced" from
   * "guessed and shown, waiting for its first recall". Only the attempts table
   * knows, and it is the source of truth — so it is asked rather than guessed at.
   */
  guessed: boolean;
};

/**
 * What the user says about how easily the answer came. Never "again" — that is
 * decided by the typed string, not claimed by the user.
 */
export type Effort = "hard" | "good" | "easy";

/** A row for `attempts`. Emitted, never stored here — persistence is elsewhere. */
export type Attempt = {
  cardId: string;
  phase: "guess" | "recall";
  typed: string;
  correct: boolean;
  /** Null for guesses: a pretest is logged but never rated. */
  rating: Grade | null;
  latencyMs: number;
  /** The card's FSRS state *before* this attempt, so history can be replayed. */
  stateBefore: FsrsCard;
  reviewedAt: Date;
};

/** Everything needed to pose the question, and nothing that answers it. */
export type Prompt = {
  gloss: string;
  hint: string | null;
  image: string | null;
  kind: "word" | "chunk";
};

export type SessionStats = {
  introduced: number;
  recalls: number;
  correct: number;
  wrong: number;
};

/**
 * The entire surface the UI sees. A discriminated union rather than a phase
 * plus a bag of optional fields, so asking for the answer during the guess
 * phase is not a bug to guard against — it does not typecheck.
 */
export type SessionView =
  | { phase: "guess"; prompt: Prompt }
  | { phase: "exposure"; prompt: Prompt; answer: string }
  /** `efforts` is the list of buttons to draw. The UI holds no grading policy. */
  | { phase: "recall"; prompt: Prompt; efforts: Effort[] }
  /** Only ever reached by a wrong answer, so there is no `correct` flag. */
  | { phase: "feedback"; expected: string; typed: string }
  | { phase: "done"; stats: SessionStats };
