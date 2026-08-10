import { Rating } from "ts-fsrs";
import type { Card as FsrsCard, Grade } from "ts-fsrs";
import { matches } from "./matching";
import type { Effort } from "./types";

const EFFORT_TO_RATING: Record<Effort, Grade> = {
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

/**
 * Which buttons to offer. Easy is withheld on the very first recall, where it
 * would send a word met twenty seconds ago eight days into the future.
 *
 * `reps` counts FSRS ratings, and guesses are never rated, so reps === 0 means
 * exactly "this word has never been recalled".
 */
export function effortsFor(card: FsrsCard): Effort[] {
  return card.reps === 0 ? ["hard", "good"] : ["hard", "good", "easy"];
}

/**
 * Typing decides pass/fail; the user only reports how hard it felt. A wrong
 * answer is Again no matter which button was pressed — including a wrong
 * accent, which is simply a wrong word.
 *
 * An effort the card is not offering falls back to Good rather than throwing:
 * Good is the default action anyway, so the worst case is a slightly generous
 * rating rather than a session that dies mid-answer.
 */
export function gradeRecall(
  typed: string,
  expected: string,
  effort: Effort,
  offered: Effort[],
): { correct: boolean; rating: Grade } {
  const correct = matches(typed, expected);
  if (!correct) return { correct, rating: Rating.Again };
  const chosen = offered.includes(effort) ? effort : "good";
  return { correct, rating: EFFORT_TO_RATING[chosen] };
}
