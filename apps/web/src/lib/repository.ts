import { SyncConflict } from "@vocab/study/commands";
import type { AnswerCommand } from "@vocab/study/commands";
import { buildDeck } from "@vocab/study/deck";
import { getDeck, getSettings, recordAnswer } from "../server/functions";

export const loadSettings = () => getSettings();

export async function loadDeck(lang: string, now: Date, dayRolloverHour = 0) {
  const { words, cards, guesses } = await getDeck({ data: { lang } });
  // Study-day boundaries belong to the learner's timezone, not the Worker's UTC clock.
  return buildDeck(
    words,
    cards.map((card) => ({
      word_id: card.word_id,
      fsrs_state: JSON.parse(card.fsrs_state) as unknown,
    })),
    guesses,
    now,
    dayRolloverHour,
  );
}

export async function persistAnswer(command: AnswerCommand, expectedUserId: string) {
  const result = await recordAnswer({ data: { answer: command, expectedUserId } });
  if (result.conflict) throw new SyncConflict();
}
