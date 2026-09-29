import type {
  AnswerCommand,
  ReviewSnapshot,
  Settings,
} from "@vocab/spaced-repetition";

import { connect } from "./connection";
import type { DatabaseBinding } from "./connection";
import {
  readSettings,
  readDeck,
  saveAnswer,
  readUiLocale,
  saveUiLocale,
  readPromptLanguage,
  savePromptLanguage,
} from "./repository";
import type { UiLocale } from "./repository";

export type { DatabaseBinding } from "./connection";
export { SaveConflict } from "./repository";

export interface UserRepository {
  uiLocale: () => Promise<UiLocale>;
  setUiLocale: (locale: UiLocale) => Promise<void>;
  settings: () => Promise<Settings>;
  promptLanguage: () => Promise<string>;
  setPromptLanguage: (language: string) => Promise<void>;
  snapshot: (language: string) => Promise<ReviewSnapshot>;
  recordAnswer: (answer: AnswerCommand) => Promise<void>;
}

/** Ownership is fixed for the repository's lifetime. Authenticate before choosing the user. */
export const createDatabase = (binding: DatabaseBinding) => {
  const db = connect(binding);
  return {
    forUser(userId: string): UserRepository {
      if (!userId.trim()) {
        throw new Error("A user ID is required.");
      }
      return {
        promptLanguage: () => readPromptLanguage(db, userId),
        recordAnswer: (answer) => saveAnswer(db, userId, answer),
        setPromptLanguage: (language) =>
          savePromptLanguage(db, userId, language),
        setUiLocale: (locale) => saveUiLocale(db, userId, locale),
        settings: () => readSettings(db, userId),
        snapshot: (language) => readDeck(db, userId, language),
        uiLocale: () => readUiLocale(db, userId),
      };
    },
  };
};
