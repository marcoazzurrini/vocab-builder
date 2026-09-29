import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const catalogueSources = sqliteTable("catalogue_sources", {
  id: text("id").primaryKey(),
  license: text("license").notNull(),
  sha256: text("sha256"),
  title: text("title").notNull(),
  url: text("url").notNull(),
  version: text("version").notNull(),
});

export const lexicalEntries = sqliteTable(
  "lexical_entries",
  {
    annotations: text("annotations", { mode: "json" })
      .$type<{
        frequency_warnings: string[];
        gender: string | null;
        morphology: {
          base: string;
          decomposition: string;
          structure: string;
        } | null;
        pronunciation: string | null;
      }>()
      .notNull(),
    forms: text("forms", { mode: "json" }).$type<string[]>().notNull(),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["word", "chunk"] }).notNull(),
    language: text("language").notNull(),
    source_id: text("source_id")
      .notNull()
      .references(() => catalogueSources.id),
    source_key: text("source_key").notNull(),
    text: text("text").notNull(),
  },
  (t) => [
    uniqueIndex("lexical_entries_source_key").on(
      t.source_id,
      t.language,
      t.source_key
    ),
    check("lexical_entries_kind", sql`${t.kind} in ('word', 'chunk')`),
    check(
      "lexical_entries_json",
      sql`json_valid(${t.forms}) and json_valid(${t.annotations})`
    ),
  ]
);

export const catalogueSenses = sqliteTable(
  "catalogue_senses",
  {
    description: text("description").notNull(),
    entry_id: text("entry_id")
      .notNull()
      .references(() => lexicalEntries.id),
    id: text("id").primaryKey(),
    part_of_speech: text("part_of_speech"),
    source_id: text("source_id")
      .notNull()
      .references(() => catalogueSources.id),
  },
  (t) => [index("catalogue_senses_entry_idx").on(t.entry_id)]
);

export const catalogueFrequencies = sqliteTable(
  "catalogue_frequencies",
  {
    entry_id: text("entry_id")
      .notNull()
      .references(() => lexicalEntries.id),
    part_of_speech: text("part_of_speech").notNull(),
    per_million: real("per_million").notNull(),
    source_id: text("source_id")
      .notNull()
      .references(() => catalogueSources.id),
    // Lexique canonical-row observations are lemma/POS frequencies, not sense counts.
    unit: text("unit").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.entry_id, t.source_id, t.unit, t.part_of_speech],
    }),
    check("catalogue_frequency_nonnegative", sql`${t.per_million} >= 0`),
  ]
);

export const catalogueFamilies = sqliteTable("catalogue_families", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  language: text("language").notNull(),
  policy: text("policy").notNull(),
  source_id: text("source_id")
    .notNull()
    .references(() => catalogueSources.id),
});

export const catalogueFamilyMembers = sqliteTable(
  "catalogue_family_members",
  {
    entry_id: text("entry_id")
      .notNull()
      .references(() => lexicalEntries.id),
    family_id: text("family_id")
      .notNull()
      .references(() => catalogueFamilies.id),
  },
  (t) => [primaryKey({ columns: [t.family_id, t.entry_id] })]
);

export const catalogueLists = sqliteTable(
  "catalogue_lists",
  {
    id: text("id").primaryKey(),
    is_default: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    language: text("language").notNull(),
    prompt_language: text("prompt_language").notNull(),
    ranking_policy: text("ranking_policy").notNull(),
    source_id: text("source_id")
      .notNull()
      .references(() => catalogueSources.id),
    title: text("title").notNull(),
  },
  (t) => [
    uniqueIndex("catalogue_one_default")
      .on(t.language, t.prompt_language)
      .where(sql`${t.is_default} = 1`),
  ]
);

export const catalogueListMembers = sqliteTable(
  "catalogue_list_members",
  {
    frequency_rank: integer("frequency_rank").notNull(),
    list_id: text("list_id")
      .notNull()
      .references(() => catalogueLists.id),
    position: integer("position").notNull(),
    sense_id: text("sense_id")
      .notNull()
      .references(() => catalogueSenses.id),
  },
  (t) => [
    primaryKey({ columns: [t.list_id, t.sense_id] }),
    uniqueIndex("catalogue_list_position").on(t.list_id, t.position),
    check(
      "catalogue_list_positive_rank",
      sql`${t.position} > 0 and ${t.frequency_rank} > 0`
    ),
  ]
);
