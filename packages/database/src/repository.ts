import { and, asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";
import { AnswerCommand, DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import type { ReviewSnapshot } from "@vocab/spaced-repetition";
import { evaluateAnswer, RevisionConflict } from "@vocab/spaced-repetition/server";
import type { AnswerTransition } from "@vocab/spaced-repetition/server";
import type { Database } from "./connection";
import * as schema from "./schema";

export async function readSettings(db: Database, userId: string) {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.user_id, userId));
  return row
    ? { lang: row.lang, newPerDay: row.new_per_day, dayRolloverHour: row.day_rollover_hour }
    : DEFAULT_SETTINGS;
}

export async function readDeck(
  db: Database,
  userId: string,
  lang: string,
): Promise<ReviewSnapshot> {
  // Every per-user query is scoped here. There is no browser-accessible SQL API or RLS in D1.
  const words = await db
    .select()
    .from(schema.words)
    .where(eq(schema.words.lang, lang))
    .orderBy(
      sql`${schema.words.freq_rank} is null`,
      asc(schema.words.freq_rank),
      asc(schema.words.id),
    );
  const cards = await db
    .select({ word_id: schema.cards.word_id, fsrs_state: schema.cards.fsrs_state })
    .from(schema.cards)
    .innerJoin(schema.words, eq(schema.words.id, schema.cards.word_id))
    .where(
      and(
        eq(schema.cards.user_id, userId),
        eq(schema.cards.card_type, "production"),
        eq(schema.words.lang, lang),
      ),
    );
  const guesses = await db
    .select({ word_id: schema.attempts.word_id, reviewed_at: schema.attempts.reviewed_at })
    .from(schema.attempts)
    .innerJoin(schema.words, eq(schema.words.id, schema.attempts.word_id))
    .where(
      and(
        eq(schema.attempts.user_id, userId),
        eq(schema.attempts.card_type, "production"),
        eq(schema.attempts.phase, "guess"),
        eq(schema.words.lang, lang),
      ),
    );
  return {
    words: words.map((word) => ({
      id: word.id,
      text: word.text,
      gloss: word.gloss,
      hint: word.hint,
      image: word.image,
      kind: word.kind,
      freqRank: word.freq_rank,
    })),
    cards: cards.map((card) => ({
      wordId: card.word_id,
      schedule: JSON.stringify(card.fsrs_state),
    })),
    guesses: guesses.map((guess) => ({ wordId: guess.word_id, reviewedAt: guess.reviewed_at })),
  };
}

export class SaveConflict extends Error {
  constructor() {
    super("Progress changed on another device. Reload before answering again.");
  }
}

/** One answer is one atomic D1 batch. The client never supplies an owner or scheduling state. */
export async function saveAnswer(db: Database, userId: string, raw: unknown) {
  const command = v.parse(AnswerCommand, raw);
  const request = JSON.stringify(command);
  const alreadySaved = async () => {
    const [row] = await db
      .select({ request: schema.attempts.request })
      .from(schema.attempts)
      .where(and(eq(schema.attempts.id, command.id), eq(schema.attempts.user_id, userId)));
    if (!row) return false;
    if (row.request !== request)
      throw new Error("An answer ID cannot be reused for a different answer.");
    return true;
  };
  if (await alreadySaved()) return;

  const [word] = await db.select().from(schema.words).where(eq(schema.words.id, command.wordId));
  if (!word) throw new Error("Word not found.");
  const [stored] = await db
    .select()
    .from(schema.cards)
    .where(
      and(
        eq(schema.cards.user_id, userId),
        eq(schema.cards.word_id, command.wordId),
        eq(schema.cards.card_type, "production"),
      ),
    );
  let transition: AnswerTransition;
  try {
    transition = evaluateAnswer(
      command,
      word.text,
      stored ? JSON.stringify(stored.fsrs_state) : undefined,
    );
  } catch (error) {
    if (error instanceof RevisionConflict) {
      if (await alreadySaved()) return;
      throw new SaveConflict();
    }
    throw error;
  }

  const insert = db.insert(schema.attempts).values({
    id: command.id,
    user_id: userId,
    word_id: word.id,
    card_type: "production",
    phase: command.phase,
    typed: command.typed,
    correct: transition.correct,
    rating: command.rating,
    latency_ms: command.latencyMs,
    state_before: JSON.parse(transition.previousSchedule),
    reviewed_at: new Date(command.reviewedAt).toISOString(),
    rep_number: transition.revision,
    request,
  });
  try {
    if (command.phase === "guess") {
      await insert;
    } else {
      // The insert trigger checks the card revision inside the same transaction.
      // Checking only above would allow two devices to overwrite each other's schedule.
      const after: unknown = JSON.parse(transition.nextSchedule!);
      await db.batch([
        insert,
        db
          .insert(schema.cards)
          .values({
            user_id: userId,
            word_id: word.id,
            card_type: "production",
            fsrs_state: after,
            revision: transition.revision,
          })
          .onConflictDoUpdate({
            target: [schema.cards.user_id, schema.cards.word_id, schema.cards.card_type],
            set: { fsrs_state: after, revision: transition.revision },
          }),
      ]);
    }
  } catch (error) {
    // A lost response or racing retry can reach the insert twice. The duplicate
    // aborts the whole batch, so it can never replay an old card over a newer one.
    if (await alreadySaved()) return;
    const message =
      error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    if (/stale_card|UNIQUE constraint failed: attempts\.(user_id|id)/.test(message))
      throw new SaveConflict();
    throw error;
  }
}
