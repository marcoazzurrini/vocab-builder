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
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  id: text("id").primaryKey(),
  image: text("image"),
  name: text("name").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable(
  "session",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    ipAddress: text("ip_address"),
    token: text("token").notNull().unique(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)]
);

export const account = sqliteTable(
  "account",
  {
    accessToken: text("access_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    accountId: text("account_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    idToken: text("id_token"),
    password: text("password"),
    providerId: text("provider_id").notNull(),
    refreshToken: text("refresh_token"),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("account_user_idx").on(t.userId),
    uniqueIndex("account_provider_idx").on(t.providerId, t.accountId),
  ]
);

export const verification = sqliteTable(
  "verification",
  {
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    value: text("value").notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)]
);

export const rateLimit = sqliteTable("rate_limit", {
  count: integer("count").notNull(),
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  lastRequest: integer("last_request").notNull(),
});

export const words = sqliteTable(
  "words",
  {
    created_at: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    freq_rank: integer("freq_rank"),
    gloss: text("gloss").notNull(),
    gloss_lang: text("gloss_lang").notNull().default("it"),
    hint: text("hint"),
    id: text("id").primaryKey(),
    image: text("image"),
    kind: text("kind", { enum: ["word", "chunk"] })
      .notNull()
      .default("word"),
    lang: text("lang").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    uniqueIndex("words_lang_text_gloss_unique").on(t.lang, t.text, t.gloss),
    index("words_lang_freq_rank_idx").on(t.lang, t.freq_rank),
    check("words_kind", sql`${t.kind} in ('word', 'chunk')`),
  ]
);

export const cards = sqliteTable(
  "cards",
  {
    card_type: text("card_type").notNull().default("production"),
    fsrs_state: text("fsrs_state", { mode: "json" }).$type<unknown>().notNull(),
    revision: integer("revision").notNull(),
    user_id: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    word_id: text("word_id")
      .notNull()
      .references(() => words.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.word_id, t.card_type] }),
    check("cards_production", sql`${t.card_type} = 'production'`),
    check("cards_revision", sql`${t.revision} > 0`),
    check("cards_json", sql`json_valid(${t.fsrs_state})`),
  ]
);

export const attempts = sqliteTable(
  "attempts",
  {
    card_type: text("card_type").notNull().default("production"),
    correct: integer("correct", { mode: "boolean" }).notNull(),
    id: text("id").primaryKey(),
    latency_ms: integer("latency_ms").notNull(),
    phase: text("phase", { enum: ["guess", "recall"] }).notNull(),
    rating: integer("rating"),
    rep_number: integer("rep_number").notNull(),
    // Exact validated command: an idempotency key may never identify two different answers.
    request: text("request").notNull(),
    reviewed_at: text("reviewed_at").notNull(),
    state_before: text("state_before", { mode: "json" })
      .$type<unknown>()
      .notNull(),
    typed: text("typed").notNull(),
    user_id: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    word_id: text("word_id")
      .notNull()
      .references(() => words.id, { onDelete: "restrict" }),
  },
  (t) => [
    uniqueIndex("attempts_one_guess_idx")
      .on(t.user_id, t.word_id, t.card_type)
      .where(sql`${t.phase} = 'guess'`),
    uniqueIndex("attempts_one_revision_idx")
      .on(t.user_id, t.word_id, t.card_type, t.rep_number)
      .where(sql`${t.phase} = 'recall'`),
    index("attempts_replay_idx").on(
      t.user_id,
      t.word_id,
      t.card_type,
      t.reviewed_at
    ),
    check("attempts_production", sql`${t.card_type} = 'production'`),
    check(
      "attempts_grading",
      sql`(${t.phase} = 'guess' and ${t.rating} is null and ${t.rep_number} = 0) or (${t.phase} = 'recall' and ${t.rating} between 1 and 4 and ${t.rating} is not null and ${t.rep_number} > 0 and ${t.correct} = (${t.rating} <> 1))`
    ),
    check("attempts_latency", sql`${t.latency_ms} between 0 and 86400000`),
    check("attempts_json", sql`json_valid(${t.state_before})`),
  ]
);

export const settings = sqliteTable(
  "settings",
  {
    day_rollover_hour: integer("day_rollover_hour").notNull().default(4),
    lang: text("lang").notNull().default("fr"),
    new_per_day: integer("new_per_day").notNull().default(15),
    user_id: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [
    check("settings_allowance", sql`${t.new_per_day} between 0 and 100`),
    check("settings_rollover", sql`${t.day_rollover_hour} between 0 and 23`),
  ]
);
