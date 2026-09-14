import type { AnswerCommand, ReviewSnapshot, Settings } from "@vocab/spaced-repetition";
import { connect } from "./connection";
import type { DatabaseBinding } from "./connection";
import { readSettings, readDeck, saveAnswer } from "./repository";

export type { DatabaseBinding } from "./connection";
export { SaveConflict } from "./repository";

export type UserRepository = {
  settings(): Promise<Settings>;
  snapshot(language: string): Promise<ReviewSnapshot>;
  recordAnswer(answer: AnswerCommand): Promise<void>;
};

/** Ownership is fixed for the repository's lifetime. Authenticate before choosing the user. */
export function createDatabase(binding: DatabaseBinding) {
  const db = connect(binding);
  return {
    forUser(userId: string): UserRepository {
      if (!userId.trim()) throw new Error("A user ID is required.");
      return {
        settings: () => readSettings(db, userId),
        snapshot: (language) => readDeck(db, userId, language),
        recordAnswer: (answer) => saveAnswer(db, userId, answer),
      };
    },
  };
}
