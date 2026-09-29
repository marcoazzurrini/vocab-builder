import * as v from "valibot";

import { commandFor } from "./answer-command";
import type { AnswerCommand } from "./answer-command";
import { restoreProgress } from "./restore-progress";
import type { ReviewSnapshot } from "./restore-progress";
import { startSession } from "./study-session";
import type { Session } from "./study-session";

export { AnswerCommand } from "./answer-command";
export { dayStart as studyDayStart } from "./study-day";
export type { ReviewSnapshot } from "./restore-progress";
export type { Effort } from "./answer-grading";
export type { SessionView } from "./study-session";
export type { Word, EntryPresentation } from "./restore-progress";
export type { Session } from "./study-session";

export interface Settings {
  lang: string;
  newPerDay: number;
  dayRolloverHour: number;
}

/** Default learning preferences when the caller supplies no settings. */
export const DEFAULT_SETTINGS: Settings = {
  dayRolloverHour: 4,
  lang: "fr",
  newPerDay: 15,
};

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
  const progress = restoreProgress(
    snapshot.words,
    snapshot.cards,
    snapshot.guesses,
    clock(),
    parsedSettings.dayRolloverHour,
    snapshot.teachings
  );
  return startSession({
    ...progress,
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
