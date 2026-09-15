import { AnswerCommand, DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import type { ReviewSnapshot } from "@vocab/spaced-repetition";
import {
  evaluateAnswer,
  RevisionConflict,
} from "@vocab/spaced-repetition/server";
import type { AnswerTransition } from "@vocab/spaced-repetition/server";
import { and, asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import type { Database } from "./connection";
import * as schema from "./schema";

export const readSettings = async (db: Database, userId: string) => {
  const [row] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.user_id, userId));
  return row
    ? {
        dayRolloverHour: row.day_rollover_hour,
        lang: row.lang,
        newPerDay: row.new_per_day,
      }
    : DEFAULT_SETTINGS;
};

export const readDeck = async (
  db: Database,
  userId: string,
  lang: string
): Promise<ReviewSnapshot> => {
  // Every per-user query is scoped here. There is no browser-accessible SQL API or RLS in D1.
  const words = await db
    .select()
    .from(schema.words)
    .where(eq(schema.words.lang, lang))
    .orderBy(
      sql`${schema.words.freq_rank} is null`,
      asc(schema.words.freq_rank),
      asc(schema.words.id)
    );
  const cards = await db
    .select({
      fsrs_state: schema.cards.fsrs_state,
      word_id: schema.cards.word_id,
    })
    .from(schema.cards)
    .innerJoin(schema.words, eq(schema.words.id, schema.cards.word_id))
    .where(
      and(
        eq(schema.cards.user_id, userId),
        eq(schema.cards.card_type, "production"),
        eq(schema.words.lang, lang)
      )
    );
  const guesses = await db
    .select({
      reviewed_at: schema.attempts.reviewed_at,
      word_id: schema.attempts.word_id,
    })
    .from(schema.attempts)
    .innerJoin(schema.words, eq(schema.words.id, schema.attempts.word_id))
    .where(
      and(
        eq(schema.attempts.user_id, userId),
        eq(schema.attempts.card_type, "production"),
        eq(schema.attempts.phase, "guess"),
        eq(schema.words.lang, lang)
      )
    );
  return {
    cards: cards.map((card) => ({
      schedule: JSON.stringify(card.fsrs_state),
      wordId: card.word_id,
    })),
    guesses: guesses.map((guess) => ({
      reviewedAt: guess.reviewed_at,
      wordId: guess.word_id,
    })),
    words: words.map((word) => ({
      freqRank: word.freq_rank,
      gloss: word.gloss,
      hint: word.hint,
      id: word.id,
      image: word.image,
      kind: word.kind,
      text: word.text,
    })),
  };
};

// oxlint-disable-next-line unicorn/custom-error-definition -- Preserve the public constructor name and existing serialized Error category.
export class SaveConflict extends Error {
  // oxlint-disable-next-line unicorn/custom-error-definition -- Error.name remains inherited for compatibility with existing callers.
  constructor() {
    super("Progress changed on another device. Reload before answering again.");
  }
}

const parseAnswerCommand = v.parser(AnswerCommand);

/** One answer is one atomic D1 batch. The client never supplies an owner or scheduling state. */
export const saveAnswer = async (
  db: Database,
  userId: string,
  answer: AnswerCommand
) => {
  const command = parseAnswerCommand(answer);
  const request = JSON.stringify(command);
  const alreadySaved = async () => {
    const [row] = await db
      .select({ request: schema.attempts.request })
      .from(schema.attempts)
      .where(
        and(
          eq(schema.attempts.id, command.id),
          eq(schema.attempts.user_id, userId)
        )
      );
    if (!row) {
      return false;
    }
    // Historical requests may use a different schema property order. Parse both
    // commands with the current strict schema before comparing their canonical JSON.
    const savedCommand = parseAnswerCommand(JSON.parse(row.request));
    if (JSON.stringify(savedCommand) !== request) {
      throw new Error("An answer ID cannot be reused for a different answer.");
    }
    return true;
  };
  if (await alreadySaved()) {
    return;
  }

  const [word] = await db
    .select()
    .from(schema.words)
    .where(eq(schema.words.id, command.wordId));
  if (!word) {
    throw new Error("Word not found.");
  }
  const [stored] = await db
    .select()
    .from(schema.cards)
    .where(
      and(
        eq(schema.cards.user_id, userId),
        eq(schema.cards.word_id, command.wordId),
        eq(schema.cards.card_type, "production")
      )
    );
  let transition: AnswerTransition;
  try {
    transition = evaluateAnswer(
      command,
      word.text,
      stored ? JSON.stringify(stored.fsrs_state) : undefined
    );
  } catch (error) {
    if (error instanceof RevisionConflict) {
      if (await alreadySaved()) {
        return;
      }
      throw new SaveConflict();
    }
    throw error;
  }

  const insert = db.insert(schema.attempts).values({
    card_type: "production",
    correct: transition.correct,
    id: command.id,
    latency_ms: command.latencyMs,
    phase: command.phase,
    rating: command.rating,
    rep_number: transition.revision,
    request,
    reviewed_at: new Date(command.reviewedAt).toISOString(),
    state_before: JSON.parse(transition.previousSchedule),
    typed: command.typed,
    user_id: userId,
    word_id: word.id,
  });
  try {
    if (command.phase === "guess") {
      await insert;
    } else {
      // The insert trigger checks the card revision inside the same transaction.
      // Checking only above would allow two devices to overwrite each other's schedule.
      if (transition.nextSchedule === null) {
        throw new Error("Recall did not produce a schedule.");
      }
      const after: unknown = JSON.parse(transition.nextSchedule);
      await db.batch([
        insert,
        db
          .insert(schema.cards)
          .values({
            card_type: "production",
            fsrs_state: after,
            revision: transition.revision,
            user_id: userId,
            word_id: word.id,
          })
          .onConflictDoUpdate({
            set: { fsrs_state: after, revision: transition.revision },
            target: [
              schema.cards.user_id,
              schema.cards.word_id,
              schema.cards.card_type,
            ],
          }),
      ]);
    }
  } catch (error) {
    // A lost response or racing retry can reach the insert twice. The duplicate
    // aborts the whole batch, so it can never replay an old card over a newer one.
    if (await alreadySaved()) {
      return;
    }
    const message =
      error instanceof Error
        ? `${error.message} ${String(error.cause ?? "")}`
        : String(error);
    if (
      /stale_card|UNIQUE constraint failed: attempts\.(?:user_id|id)/u.test(
        message
      )
    ) {
      throw new SaveConflict();
    }
    throw error;
  }
};
