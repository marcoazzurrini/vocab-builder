import { AnswerCommand, DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import type { ReviewSnapshot } from "@vocab/spaced-repetition";
import {
  evaluateAnswer,
  initialRecallAt,
  teachingSchedule,
  RevisionConflict,
} from "@vocab/spaced-repetition/server";
import type { AnswerTransition } from "@vocab/spaced-repetition/server";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import * as v from "valibot";

import { catalogueLists } from "./catalogue-schema";
import type { Database } from "./connection";
import { presentWords } from "./presentations";
import * as schema from "./schema";

export type UiLocale = (typeof schema.settings.$inferSelect)["ui_locale"];

export const readUiLocale = async (
  db: Database,
  userId: string
): Promise<UiLocale> => {
  const [row] = await db
    .select({ uiLocale: schema.settings.ui_locale })
    .from(schema.settings)
    .where(eq(schema.settings.user_id, userId));
  return row?.uiLocale ?? null;
};

export const saveUiLocale = async (
  db: Database,
  userId: string,
  uiLocale: UiLocale
): Promise<void> => {
  await db
    .insert(schema.settings)
    .values({ ui_locale: uiLocale, user_id: userId })
    .onConflictDoUpdate({
      set: { ui_locale: uiLocale },
      target: schema.settings.user_id,
    });
};

export const readPromptLanguage = async (
  db: Database,
  userId: string
): Promise<string> => {
  const [row] = await db
    .select({ language: schema.settings.prompt_language })
    .from(schema.settings)
    .where(eq(schema.settings.user_id, userId));
  return row?.language ?? "it";
};

export const savePromptLanguage = async (
  db: Database,
  userId: string,
  language: string
): Promise<void> => {
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(language)) {
    throw new Error("Invalid prompt language.");
  }
  await db
    .insert(schema.settings)
    .values({ prompt_language: language, user_id: userId })
    .onConflictDoUpdate({
      set: { prompt_language: language },
      target: schema.settings.user_id,
    });
};

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
    : { ...DEFAULT_SETTINGS };
};

export const readDeck = async (
  db: Database,
  userId: string,
  lang: string
): Promise<ReviewSnapshot> => {
  // Every per-user query is scoped here. There is no browser-accessible SQL API or RLS in D1.
  const promptLanguage = await readPromptLanguage(db, userId);
  const [list] = await db
    .select({ id: catalogueLists.id })
    .from(catalogueLists)
    .where(
      and(
        eq(catalogueLists.language, lang),
        eq(catalogueLists.prompt_language, promptLanguage),
        eq(catalogueLists.is_default, true)
      )
    );
  // Keep the outer ID explicitly qualified: Drizzle removes interpolated column
  // qualifiers in single-table SELECT projections, which would bind "id" to p.id.
  const rank = list
    ? sql<
        number | null
      >`coalesce((select m.position from catalogue_list_members m join catalogue_prompts p on p.sense_id=m.sense_id where m.list_id=${list.id} and p.word_id="words"."id"), ${schema.words.freq_rank})`
    : schema.words.freq_rank;
  // A new default collection must never hide previously introduced legacy cards.
  const membership = list
    ? sql`(exists (select 1 from catalogue_list_members m join catalogue_prompts p on p.sense_id=m.sense_id where m.list_id=${list.id} and p.word_id=${schema.words.id}) or exists (select 1 from attempts a where a.word_id=${schema.words.id} and a.user_id=${userId}) or exists (select 1 from teachings t where t.word_id=${schema.words.id} and t.user_id=${userId}))`
    : sql`(not exists (select 1 from catalogue_prompts p where p.word_id=${schema.words.id} and p.id=p.word_id) or exists (select 1 from attempts a where a.word_id=${schema.words.id} and a.user_id=${userId}) or exists (select 1 from teachings t where t.word_id=${schema.words.id} and t.user_id=${userId}))`;
  const words = await db
    .select({
      ...getTableColumns(schema.words),
      freq_rank: rank,
      is_catalogue: sql<number>`exists (select 1 from catalogue_prompts p where p.word_id="words"."id")`,
    })
    .from(schema.words)
    .where(
      and(
        eq(schema.words.lang, lang),
        eq(schema.words.gloss_lang, promptLanguage),
        membership
      )
    )
    .orderBy(sql`${rank} is null`, asc(rank), asc(schema.words.id));
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
        eq(schema.words.lang, lang),
        eq(schema.words.gloss_lang, promptLanguage)
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
        eq(schema.words.lang, lang),
        eq(schema.words.gloss_lang, promptLanguage)
      )
    );
  const teachings = await db
    .select({
      initialRecallAt: schema.teachings.initial_recall_at,
      reviewedAt: schema.teachings.completed_at,
      wordId: schema.teachings.word_id,
    })
    .from(schema.teachings)
    .innerJoin(schema.words, eq(schema.words.id, schema.teachings.word_id))
    .where(
      and(
        eq(schema.teachings.user_id, userId),
        eq(schema.teachings.card_type, "production"),
        eq(schema.words.lang, lang),
        eq(schema.words.gloss_lang, promptLanguage)
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
    teachings,
    words: await presentWords(
      db,
      words.map((word) => {
        const target: ReviewSnapshot["words"][number] = {
          freqRank: word.freq_rank,
          gloss: word.gloss,
          hint: word.is_catalogue ? null : word.hint,
          id: word.id,
          image: word.image,
          kind: word.kind,
          text: word.text,
        };
        if (word.is_catalogue && word.hint) {
          target.revealNote = word.hint;
        }
        return target;
      })
    ),
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
    const [savedAttempts, savedTeachings] = await Promise.all([
      db
        .select({ request: schema.attempts.request })
        .from(schema.attempts)
        .where(
          and(
            eq(schema.attempts.id, command.id),
            eq(schema.attempts.user_id, userId)
          )
        ),
      db
        .select({ request: schema.teachings.request })
        .from(schema.teachings)
        .where(
          and(
            eq(schema.teachings.id, command.id),
            eq(schema.teachings.user_id, userId)
          )
        ),
    ]);
    const row = savedAttempts[0] ?? savedTeachings[0];
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
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 may throw arbitrary values; preserve non-conflict failures unchanged.
  const handleWriteError = async (error: unknown) => {
    // A duplicate aborts the transaction before it can replace newer progress.
    if (await alreadySaved()) {
      return;
    }
    const message =
      error instanceof Error
        ? `${error.message} ${String(error.cause ?? "")}`
        : String(error);
    if (
      /stale_card|history_id_conflict|teachings_are_append_only|UNIQUE constraint failed: (?:attempts|teachings)\.(?:user_id|id)/u.test(
        message
      )
    ) {
      throw new SaveConflict();
    }
    throw error;
  };

  const [word] = await db
    .select()
    .from(schema.words)
    .where(eq(schema.words.id, command.wordId));
  if (!word) {
    throw new Error("Word not found.");
  }
  if (command.phase === "teach") {
    const completedAt = new Date(command.reviewedAt).toISOString();
    if (new Date(completedAt).getTime() > Date.now() + 5 * 60_000) {
      throw new Error("Review time is in the future. Check your device clock.");
    }
    try {
      // The insertion guards and unique key run in the transaction, not in a
      // preflight read. Completion never creates a guess or a rated card.
      await db.batch([
        db.insert(schema.teachings).values({
          completed_at: completedAt,
          id: command.id,
          initial_recall_at: initialRecallAt(completedAt),
          latency_ms: command.latencyMs,
          request,
          user_id: userId,
          word_id: word.id,
        }),
      ]);
    } catch (error) {
      await handleWriteError(error);
    }
    return;
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
  const [teaching] = await db
    .select({ initialRecallAt: schema.teachings.initial_recall_at })
    .from(schema.teachings)
    .where(
      and(
        eq(schema.teachings.user_id, userId),
        eq(schema.teachings.word_id, command.wordId),
        eq(schema.teachings.card_type, "production")
      )
    );
  let previousSchedule: string | undefined;
  if (stored) {
    previousSchedule = JSON.stringify(stored.fsrs_state);
  } else if (command.phase === "recall" && teaching) {
    previousSchedule = teachingSchedule(teaching.initialRecallAt);
  }
  let transition: AnswerTransition;
  try {
    transition = evaluateAnswer(command, word.text, previousSchedule);
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
    await handleWriteError(error);
  }
};
