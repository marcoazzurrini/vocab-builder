import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import * as v from "valibot";

const text = v.pipe(v.string(), v.minLength(1));
const CatalogueWord = v.object({
  created_at: v.optional(
    v.pipe(
      v.string(),
      v.check(
        (value) => !Number.isNaN(Date.parse(value)),
        "Invalid creation time."
      )
    )
  ),
  freq_rank: v.nullable(v.pipe(v.number(), v.integer())),
  gloss: text,
  gloss_lang: text,
  hint: v.nullable(v.string()),
  id: text,
  image: v.nullable(v.string()),
  kind: v.picklist(["word", "chunk"]),
  lang: text,
  text,
});

const Catalogue = v.pipe(v.array(CatalogueWord), v.minLength(1));
export const parseCatalogue = v.parser(Catalogue);

const quote = (value: string | number | null | undefined) =>
  value === null || value === undefined
    ? "NULL"
    : `'${String(value).replaceAll("'", "''")}'`;

/** Validate the entire import before executing SQL; never replace IDs referenced by progress. */
export const compileCatalogue = v.parser(
  v.pipe(
    Catalogue,
    v.transform((words) => {
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
        if (keys.has(key) || ids.has(word.id)) {
          throw new Error("Duplicate catalogue entry or ID.");
        }
        keys.add(key);
        ids.add(word.id);
        const fields =
          word.created_at === undefined
            ? columns
            : [...columns, "created_at" as const];
        return `INSERT INTO words (${fields.join(",")}) VALUES (${fields.map((column) => quote(word[column])).join(",")}) ON CONFLICT(lang,text,gloss) DO UPDATE SET gloss_lang=excluded.gloss_lang,hint=excluded.hint,image=excluded.image,kind=excluded.kind,freq_rank=excluded.freq_rank${word.created_at === undefined ? "" : ",created_at=excluded.created_at"};`;
      });
      return { count: words.length, sql: statements.join("\n") };
    })
  )
);

// Importing compileCatalogue must not parse CLI arguments or modify a database.
if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      remote: { default: false, type: "boolean" },
    },
  });
  if (!values.config) {
    throw new Error(
      "Provide --config with the target Worker's Wrangler configuration."
    );
  }
  if (positionals.length > 1) {
    throw new Error("Provide at most one catalogue file.");
  }
  const source = positionals[0] ?? new URL("words.json", import.meta.url);
  const catalogue = compileCatalogue(
    JSON.parse(await readFile(source, "utf-8"))
  );
  const config = path.resolve(values.config);
  const directory = await mkdtemp(path.join(tmpdir(), "vocab-words-"));
  try {
    const file = path.join(directory, "words.sql");
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
      }
    );
    console.log(
      `Imported ${catalogue.count} words. No progress or authentication data was changed.`
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
