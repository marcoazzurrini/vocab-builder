import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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

// Importing compileCatalogue must not parse CLI arguments or modify a database.
if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string" }, remote: { type: "boolean", default: false } },
  });
  if (!values.config)
    throw new Error("Provide --config with the target Worker's Wrangler configuration.");
  if (positionals.length > 1) throw new Error("Provide at most one catalogue file.");
  const source = positionals[0] ?? new URL("./words.json", import.meta.url);
  const catalogue = compileCatalogue(JSON.parse(await readFile(source, "utf8")));
  const config = resolve(values.config);
  const directory = await mkdtemp(join(tmpdir(), "vocab-words-"));
  try {
    const file = join(directory, "words.sql");
    await writeFile(file, catalogue.sql);
    execFileSync(
      "bun",
      [
        "run",
        "wrangler",
        "d1",
        "execute",
        "DB",
        values.remote ? "--remote" : "--local",
        "--config",
        config,
        "--file",
        file,
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        stdio: "inherit",
      },
    );
    console.log(
      `Imported ${catalogue.count} words. No progress or authentication data was changed.`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
