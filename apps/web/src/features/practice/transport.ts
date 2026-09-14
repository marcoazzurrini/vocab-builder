import type { AnswerCommand } from "@vocab/spaced-repetition";
import { SyncConflict } from "./sync-conflict";
import { getSnapshot, getSettings, recordAnswer } from "../../server/functions";

export const loadSettings = () => getSettings();
export const loadSnapshot = (lang: string) => getSnapshot({ data: { lang } });

export async function persistAnswer(command: AnswerCommand, expectedUserId: string) {
  const result = await recordAnswer({ data: { answer: command, expectedUserId } });
  if (result.conflict) throw new SyncConflict();
}
