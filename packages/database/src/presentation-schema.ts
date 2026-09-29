import type { EntryPresentation } from "@vocab/spaced-repetition";
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

import { catalogueSources } from "./catalogue-schema";
import { cataloguePrompts } from "./schema";

/** Versioned teaching copy is additive; historical cues and answers stay intact. */
export const cataloguePresentations = sqliteTable(
  "catalogue_presentations",
  {
    content: text("content", { mode: "json" })
      .$type<EntryPresentation>()
      .notNull(),
    prompt_id: text("prompt_id")
      .notNull()
      .references(() => cataloguePrompts.id, { onDelete: "restrict" }),
    source_id: text("source_id")
      .notNull()
      .references(() => catalogueSources.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.prompt_id, t.version] }),
    check("catalogue_presentation_version", sql`${t.version} > 0`),
    check("catalogue_presentation_json", sql`json_valid(${t.content})`),
  ]
);
