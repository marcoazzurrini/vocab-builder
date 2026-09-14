import * as v from "valibot";

const text = v.pipe(v.string(), v.minLength(1));
const CatalogueWord = v.object({
  id: text,
  lang: text,
  text,
  gloss: text,
  gloss_lang: text,
  hint: v.nullable(v.string()),
  image: v.nullable(v.string()),
  kind: v.picklist(["word", "chunk"]),
  freq_rank: v.nullable(v.pipe(v.number(), v.integer())),
  created_at: v.optional(
    v.pipe(
      v.string(),
      v.check((value) => !Number.isNaN(Date.parse(value)), "Invalid creation time."),
    ),
  ),
});

/** Validate the entire import before executing SQL; never replace IDs referenced by progress. */
export function compileCatalogue(raw: unknown): { count: number; sql: string } {
  const words = v.parse(v.pipe(v.array(CatalogueWord), v.minLength(1)), raw);
  const quote = (value: string | number | null | undefined) =>
    value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
  const columns = [
    "id",
    "lang",
    "text",
    "gloss",
    "gloss_lang",
    "hint",
    "image",
    "kind",
    "freq_rank",
  ] as const;
  const keys = new Set<string>();
  const ids = new Set<string>();
  const statements = words.map((word) => {
    const key = JSON.stringify([word.lang, word.text, word.gloss]);
    if (keys.has(key) || ids.has(word.id)) throw new Error("Duplicate catalogue entry or ID.");
    keys.add(key);
    ids.add(word.id);
    const fields = word.created_at === undefined ? columns : [...columns, "created_at" as const];
    return `INSERT INTO words (${fields.join(",")}) VALUES (${fields.map((column) => quote(word[column])).join(",")}) ON CONFLICT(lang,text,gloss) DO UPDATE SET gloss_lang=excluded.gloss_lang,hint=excluded.hint,image=excluded.image,kind=excluded.kind,freq_rank=excluded.freq_rank${word.created_at === undefined ? "" : ",created_at=excluded.created_at"};`;
  });
  return { count: words.length, sql: statements.join("\n") };
}
