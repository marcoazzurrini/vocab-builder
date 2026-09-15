import type { AnswerCommand } from "@vocab/spaced-repetition";

import { getSnapshot, getSettings, recordAnswer } from "../../server/functions";
import { SyncConflict } from "./sync-conflict";

export const loadSettings = () => getSettings();
export const loadSnapshot = (lang: string) => getSnapshot({ data: { lang } });

export const persistAnswer = async (
  command: AnswerCommand,
  expectedUserId: string
) => {
  const result = await recordAnswer({
    data: { answer: command, expectedUserId },
  });
  if (result.conflict) {
    throw new SyncConflict();
  }
};

export const practiceTransport = { loadSettings, loadSnapshot, persistAnswer };
export type PracticeTransport = typeof practiceTransport;
