import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Better Auth owns these four tables. Dates use its millisecond timestamp convention.
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("account_user_idx").on(t.userId),
    uniqueIndex("account_provider_idx").on(t.providerId, t.accountId),
  ],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

export const words = sqliteTable(
  "words",
  {
    id: text("id").primaryKey(),
    lang: text("lang").notNull(),
    text: text("text").notNull(),
    gloss: text("gloss").notNull(),
    gloss_lang: text("gloss_lang").notNull().default("it"),
    hint: text("hint"),
    image: text("image"),
    kind: text("kind", { enum: ["word", "chunk"] })
      .notNull()
      .default("word"),
    freq_rank: integer("freq_rank"),
    created_at: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (t) => [
    uniqueIndex("words_lang_text_gloss_unique").on(t.lang, t.text, t.gloss),
    index("words_lang_freq_rank_idx").on(t.lang, t.freq_rank),
    check("words_kind", sql`${t.kind} in ('word', 'chunk')`),
  ],
);

export const cards = sqliteTable(
  "cards",
  {
    user_id: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    word_id: text("word_id")
      .notNull()
      .references(() => words.id, { onDelete: "restrict" }),
    card_type: text("card_type").notNull().default("production"),
    fsrs_state: text("fsrs_state", { mode: "json" }).$type<unknown>().notNull(),
    revision: integer("revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.word_id, t.card_type] }),
    check("cards_production", sql`${t.card_type} = 'production'`),
    check("cards_revision", sql`${t.revision} > 0`),
    check("cards_json", sql`json_valid(${t.fsrs_state})`),
  ],
);

export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    word_id: text("word_id")
      .notNull()
      .references(() => words.id, { onDelete: "restrict" }),
    card_type: text("card_type").notNull().default("production"),
    phase: text("phase", { enum: ["guess", "recall"] }).notNull(),
    typed: text("typed").notNull(),
    correct: integer("correct", { mode: "boolean" }).notNull(),
    rating: integer("rating"),
    latency_ms: integer("latency_ms").notNull(),
    state_before: text("state_before", { mode: "json" }).$type<unknown>().notNull(),
    reviewed_at: text("reviewed_at").notNull(),
    rep_number: integer("rep_number").notNull(),
    // Exact validated command: an idempotency key may never identify two different answers.
    request: text("request").notNull(),
  },
  (t) => [
    uniqueIndex("attempts_one_guess_idx")
      .on(t.user_id, t.word_id, t.card_type)
      .where(sql`${t.phase} = 'guess'`),
    uniqueIndex("attempts_one_revision_idx")
      .on(t.user_id, t.word_id, t.card_type, t.rep_number)
      .where(sql`${t.phase} = 'recall'`),
    index("attempts_replay_idx").on(t.user_id, t.word_id, t.card_type, t.reviewed_at),
    check("attempts_production", sql`${t.card_type} = 'production'`),
    check(
      "attempts_grading",
      sql`(${t.phase} = 'guess' and ${t.rating} is null and ${t.rep_number} = 0) or (${t.phase} = 'recall' and ${t.rating} between 1 and 4 and ${t.rating} is not null and ${t.rep_number} > 0 and ${t.correct} = (${t.rating} <> 1))`,
    ),
    check("attempts_latency", sql`${t.latency_ms} between 0 and 86400000`),
    check("attempts_json", sql`json_valid(${t.state_before})`),
  ],
);

export const settings = sqliteTable(
  "settings",
  {
    user_id: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    lang: text("lang").notNull().default("fr"),
    new_per_day: integer("new_per_day").notNull().default(15),
    day_rollover_hour: integer("day_rollover_hour").notNull().default(4),
  },
  (t) => [
    check("settings_allowance", sql`${t.new_per_day} between 0 and 100`),
    check("settings_rollover", sql`${t.day_rollover_hour} between 0 and 23`),
  ],
);
