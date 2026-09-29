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

import {
  catalogueFamilies,
  catalogueLists,
  catalogueSources,
  lexicalEntries,
} from "./catalogue-schema";
import { cataloguePrompts } from "./schema";

export const catalogueForms = sqliteTable(
  "catalogue_forms",
  {
    entry_id: text("entry_id")
      .notNull()
      .references(() => lexicalEntries.id),
    gender: text("gender"),
    id: text("id").primaryKey(),
    number: text("number"),
    part_of_speech: text("part_of_speech").notNull(),
    per_million: real("per_million").notNull(),
    source_id: text("source_id")
      .notNull()
      .references(() => catalogueSources.id),
    text: text("text").notNull(),
    verb_info: text("verb_info"),
  },
  (t) => [
    uniqueIndex("catalogue_form_observation").on(
      t.entry_id,
      t.source_id,
      t.text,
      t.part_of_speech
    ),
    check("catalogue_form_frequency", sql`${t.per_million} >= 0`),
  ]
);

export const catalogueFamilyRanks = sqliteTable(
  "catalogue_family_ranks",
  {
    family_id: text("family_id")
      .notNull()
      .references(() => catalogueFamilies.id),
    per_million: real("per_million").notNull(),
    rank: integer("rank").notNull(),
    resource_id: text("resource_id")
      .notNull()
      .references(() => catalogueSources.id),
  },
  (t) => [
    primaryKey({ columns: [t.resource_id, t.family_id] }),
    uniqueIndex("catalogue_family_rank").on(t.resource_id, t.rank),
    check(
      "catalogue_family_rank_positive",
      sql`${t.rank} > 0 and ${t.per_million} >= 0`
    ),
  ]
);

export const catalogueCurricula = sqliteTable("catalogue_curricula", {
  content_hash: text("content_hash").notNull(),
  id: text("id")
    .primaryKey()
    .references(() => catalogueLists.id),
  resource_id: text("resource_id")
    .notNull()
    .references(() => catalogueSources.id),
});

export const catalogueCurriculumSteps = sqliteTable(
  "catalogue_curriculum_steps",
  {
    curriculum_id: text("curriculum_id")
      .notNull()
      .references(() => catalogueCurricula.id),
    entry_id: text("entry_id")
      .notNull()
      .references(() => lexicalEntries.id),
    family_id: text("family_id")
      .notNull()
      .references(() => catalogueFamilies.id),
    form_id: text("form_id").references(() => catalogueForms.id),
    id: text("id").notNull(),
    position: integer("position").notNull(),
    prerequisite: text("prerequisite"),
    prompt_id: text("prompt_id")
      .notNull()
      .references(() => cataloguePrompts.id),
  },
  (t) => [
    primaryKey({ columns: [t.curriculum_id, t.id] }),
    uniqueIndex("curriculum_step_position").on(t.curriculum_id, t.position),
    uniqueIndex("curriculum_step_prompt").on(t.curriculum_id, t.prompt_id),
    index("curriculum_step_family").on(t.family_id),
    check("curriculum_step_position_positive", sql`${t.position} > 0`),
  ]
);
