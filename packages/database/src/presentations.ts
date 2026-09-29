import type { Word } from "@vocab/spaced-repetition";
import { desc, eq } from "drizzle-orm";

import type { Database } from "./connection";
import { cataloguePresentations } from "./presentation-schema";
import { cataloguePrompts } from "./schema";

/** Presentation does not change a word's ID, historical cue, or recall state. */
export const presentWords = async (
  db: Database,
  words: Word[]
): Promise<Word[]> => {
  if (words.length === 0) {
    return words;
  }
  const rows = await db
    .select({
      content: cataloguePresentations.content,
      wordId: cataloguePrompts.word_id,
    })
    .from(cataloguePresentations)
    .innerJoin(
      cataloguePrompts,
      eq(cataloguePresentations.prompt_id, cataloguePrompts.id)
    )
    .orderBy(desc(cataloguePresentations.version))
    .all();
  const presentations = new Map<string, Word["presentation"]>();
  for (const row of rows) {
    if (!presentations.has(row.wordId)) {
      presentations.set(row.wordId, row.content);
    }
  }
  return words.map((word) => {
    const presentation = presentations.get(word.id);
    return presentation ? { ...word, presentation } : word;
  });
};
