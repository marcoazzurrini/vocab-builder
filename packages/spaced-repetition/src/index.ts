import * as v from "valibot";

import { commandFor } from "./lib/commands";
import type { AnswerCommand } from "./lib/commands";
import { buildDeck, DEFAULT_SETTINGS } from "./lib/deck";
import type { ReviewSnapshot, Settings } from "./lib/deck";
import { createSession as startSession } from "./session";
import type { Session } from "./session";

export { AnswerCommand } from "./lib/commands";
export { DEFAULT_SETTINGS } from "./lib/deck";
export { dayStart as studyDayStart } from "./lib/day";
export type { ReviewSnapshot, Settings } from "./lib/deck";
export type { Effort, SessionView, Word } from "./session/types";
export type { Session } from "./session";

export interface SessionOptions {
  snapshot: ReviewSnapshot;
  settings?: Settings;
  /** Persist to a local outbox synchronously, or throw without accepting the command. */
  acceptAnswer?: (answer: AnswerCommand) => undefined;
  clock?: () => Date;
}

const SessionSettings = v.object({
  dayRolloverHour: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(23)
  ),
  lang: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  newPerDay: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
});

/** Reconstruct progress, enforce the daily allowance, and accept durable answer commands. */
export const createSession = ({
  snapshot,
  settings = DEFAULT_SETTINGS,
  acceptAnswer,
  clock = () => new Date(),
}: SessionOptions): Session => {
  if (acceptAnswer?.constructor.name === "AsyncFunction") {
    throw new TypeError(
      "Answer acceptance must be synchronous; synchronize the outbox separately."
    );
  }
  const parsedSettings = v.parse(SessionSettings, settings);
  const deck = buildDeck(
    snapshot.words,
    snapshot.cards,
    snapshot.guesses,
    clock(),
    parsedSettings.dayRolloverHour
  );
  return startSession({
    ...deck,
    accept: ({ attempt }) => {
      // Validate even without a sink. Rejection must precede publishing session state.
      const command = commandFor(attempt);
      acceptAnswer?.(command);
    },
    clock,
    dayRolloverHour: parsedSettings.dayRolloverHour,
    newPerDay: parsedSettings.newPerDay,
  });
};
