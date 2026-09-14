import { buildDeck, DEFAULT_SETTINGS } from "./lib/deck";
import type { ReviewSnapshot, Settings } from "./lib/deck";
import { commandFor } from "./lib/commands";
import type { AnswerCommand } from "./lib/commands";
import { createSession as startSession } from "./session";
import type { Session } from "./session";

export { AnswerCommand } from "./lib/commands";
export { DEFAULT_SETTINGS } from "./lib/deck";
export { dayStart as studyDayStart } from "./lib/day";
export type { ReviewSnapshot, Settings } from "./lib/deck";
export type { Effort, SessionView, Word } from "./session/types";
export type { Session } from "./session";

export type SessionOptions = {
  snapshot: ReviewSnapshot;
  settings?: Settings;
  onAnswer?: (answer: AnswerCommand) => void;
  clock?: () => Date;
};

/** Reconstruct progress, enforce the daily allowance, and emit durable answer commands. */
export function createSession({
  snapshot,
  settings = DEFAULT_SETTINGS,
  onAnswer,
  clock = () => new Date(),
}: SessionOptions): Session {
  const deck = buildDeck(
    snapshot.words,
    snapshot.cards,
    snapshot.guesses,
    clock(),
    settings.dayRolloverHour,
  );
  return startSession({
    ...deck,
    newPerDay: settings.newPerDay,
    dayRolloverHour: settings.dayRolloverHour,
    clock,
    onAttempt: onAnswer ? (attempt) => onAnswer(commandFor(attempt)) : undefined,
  });
}
