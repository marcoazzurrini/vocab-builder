import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createEmptyCard, fsrs } from "ts-fsrs";
import * as v from "valibot";
import { AnswerCommand } from "../../lib/commands";
import { DEFAULT_SETTINGS, reviveFsrsCard } from "../../lib/deck";
import { effortsFor } from "../../session/grading";
import { matches } from "../../session/matching";
import * as schema from "./schema";

export function database(binding: D1Database) {
  return drizzle(binding, { schema });
}
type Database = ReturnType<typeof database>;

export async function readSettings(db: Database, userId: string) {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.user_id, userId));
  return row
    ? { lang: row.lang, newPerDay: row.new_per_day, dayRolloverHour: row.day_rollover_hour }
    : DEFAULT_SETTINGS;
}

export async function readDeck(db: Database, userId: string, lang: string) {
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
    words,
    cards: cards.map((card) => ({
      word_id: card.word_id,
      fsrs_state: JSON.stringify(card.fsrs_state),
    })),
    guesses,
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
  const now = new Date(command.reviewedAt);
  if (now.getTime() > Date.now() + 5 * 60_000)
    throw new Error("Review time is in the future. Check your device clock.");
  const before = stored ? reviveFsrsCard(stored.fsrs_state) : createEmptyCard(now);
  if (before.reps !== command.expectedReps || (before.last_review && now < before.last_review)) {
    if (await alreadySaved()) return;
    throw new SaveConflict();
  }
  const correct = matches(command.typed, word.text);
  if (command.phase === "guess") {
    if (command.rating !== null || command.expectedReps !== 0)
      throw new Error("Guesses cannot be rated.");
  } else {
    if (command.rating === null || correct !== (command.rating !== 1))
      throw new Error("Rating does not match the answer.");
    if (command.rating === 4 && !effortsFor(before).includes("easy"))
      throw new Error("Easy is unavailable for a first recall.");
  }

  const insert = db.insert(schema.attempts).values({
    id: command.id,
    user_id: userId,
    word_id: word.id,
    card_type: "production",
    phase: command.phase,
    typed: command.typed,
    correct,
    rating: command.rating,
    latency_ms: command.latencyMs,
    state_before: before,
    reviewed_at: now.toISOString(),
    rep_number: command.phase === "guess" ? 0 : command.expectedReps + 1,
    request,
  });
  try {
    if (command.phase === "guess") {
      await insert;
    } else {
      // The insert trigger checks the card revision inside the same transaction.
      // Checking only above would allow two devices to overwrite each other's schedule.
      const after = fsrs({ enable_short_term: true }).next(before, now, command.rating!).card;
      await db.batch([
        insert,
        db
          .insert(schema.cards)
          .values({
            user_id: userId,
            word_id: word.id,
            card_type: "production",
            fsrs_state: after,
            revision: after.reps,
          })
          .onConflictDoUpdate({
            target: [schema.cards.user_id, schema.cards.word_id, schema.cards.card_type],
            set: { fsrs_state: after, revision: after.reps },
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
