import * as v from "valibot";

const text = v.pipe(v.string(), v.trim(), v.minLength(1));
const positive = v.pipe(v.number(), v.integer(), v.minValue(1));
const Source = v.strictObject({
  id: text,
  license: text,
  sha256: v.nullable(text),
  title: text,
  url: text,
  version: text,
});
const Prompt = v.strictObject({
  cue: text,
  // This release deliberately accepts only the canonical form. Alternatives need a grading policy.
  expected_answer: text,
  id: text,
  language: text,
  reveal_note: v.nullable(text),
  status: v.picklist(["machine_draft", "reviewed"]),
  version: positive,
});
const Sense = v.strictObject({
  description: text,
  id: text,
  part_of_speech: text,
  prompt: Prompt,
});
const Entry = v.strictObject({
  forms: v.pipe(v.array(text), v.minLength(1)),
  frequencies: v.pipe(
    v.array(
      v.strictObject({
        part_of_speech: text,
        per_million: v.pipe(v.number(), v.minValue(0)),
      })
    ),
    v.minLength(1)
  ),
  frequency_per_million: v.pipe(v.number(), v.minValue(0)),
  frequency_rank: positive,
  frequency_warnings: v.array(text),
  gender: v.nullable(text),
  id: text,
  kind: v.picklist(["word", "chunk"]),
  language: text,
  morphology: v.nullable(
    v.strictObject({
      base: text,
      decomposition: v.string(),
      structure: v.string(),
    })
  ),
  pronunciation: v.nullable(text),
  sense: Sense,
  source_key: text,
  text,
});
export const CatalogueSchema = v.strictObject({
  cue_source: Source,
  entries: v.pipe(v.array(Entry), v.minLength(1)),
  id: text,
  language: text,
  lexical_source: Source,
  prompt_language: text,
  ranking_policy: text,
  schema_version: v.literal(1),
  title: text,
});
export type Catalogue = v.InferOutput<typeof CatalogueSchema>;

export const parseCatalogue = (input: Catalogue): Catalogue => {
  const data = v.parse(CatalogueSchema, input);
  const ids = new Set<string>();
  const lemmas = new Set<string>();
  const ranks = new Set<number>();
  const add = (id: string) => {
    if (ids.has(id)) {
      throw new Error(`Duplicate ID: ${id}`);
    }
    ids.add(id);
  };
  for (const entry of data.entries) {
    add(entry.id);
    add(entry.sense.id);
    add(entry.sense.prompt.id);
    const key = JSON.stringify([entry.language, entry.text]);
    if (lemmas.has(key)) {
      throw new Error(`Duplicate lemma: ${entry.text}`);
    }
    lemmas.add(key);
    if (ranks.has(entry.frequency_rank)) {
      throw new Error("Duplicate frequency rank.");
    }
    ranks.add(entry.frequency_rank);
    if (
      entry.language !== data.language ||
      entry.sense.prompt.language !== data.prompt_language
    ) {
      throw new Error("Catalogue language mismatch.");
    }
    if (entry.sense.prompt.expected_answer !== entry.text) {
      throw new Error("Expected answer must be the canonical target.");
    }
    if (
      entry.sense.prompt.cue.normalize("NFC").toLocaleLowerCase() ===
      entry.text.normalize("NFC").toLocaleLowerCase()
    ) {
      throw new Error(`Cue reveals target: ${entry.text}`);
    }
    const positions = new Set(entry.frequencies.map((f) => f.part_of_speech));
    if (positions.size !== entry.frequencies.length) {
      throw new Error("Duplicate lemma/POS frequency observation.");
    }
    const sum = entry.frequencies.reduce((n, f) => n + f.per_million, 0);
    if (Math.abs(sum - entry.frequency_per_million) > 0.001) {
      throw new Error(`Frequency aggregation mismatch: ${entry.text}`);
    }
  }
  for (let i = 1; i < data.entries.length; i += 1) {
    const previous = data.entries[i - 1];
    const current = data.entries[i];
    if (!previous || !current) {
      throw new Error("Missing catalogue entry.");
    }
    if (
      previous.frequency_rank >= current.frequency_rank ||
      previous.frequency_per_million < current.frequency_per_million
    ) {
      throw new Error("Entries must retain descending frequency order.");
    }
  }
  return data;
};
