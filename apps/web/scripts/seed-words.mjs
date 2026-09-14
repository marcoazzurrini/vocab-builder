import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const source =
  args.find((arg) => !arg.startsWith("--")) ?? new URL("../data/words.json", import.meta.url);
const words = JSON.parse(await readFile(source, "utf8"));
if (!Array.isArray(words) || !words.length) throw new Error("Expected a nonempty array of words.");
const quote = (value) => (value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);
const columns = ["id", "lang", "text", "gloss", "gloss_lang", "hint", "image", "kind", "freq_rank"];
const seen = new Set();
const statements = words.map((word) => {
  for (const field of ["id", "lang", "text", "gloss", "gloss_lang"]) {
    if (typeof word[field] !== "string" || !word[field])
      throw new Error(`Invalid word field: ${field}`);
  }
  if (!["word", "chunk"].includes(word.kind)) throw new Error("Invalid word kind.");
  if (word.freq_rank !== null && !Number.isInteger(word.freq_rank))
    throw new Error("Invalid frequency rank.");
  for (const field of ["hint", "image"])
    if (word[field] !== null && typeof word[field] !== "string")
      throw new Error(`Invalid ${field}.`);
  const key = JSON.stringify([word.lang, word.text, word.gloss]);
  if (seen.has(key)) throw new Error("Duplicate catalogue entry.");
  seen.add(key);
  if (
    word.created_at !== undefined &&
    (typeof word.created_at !== "string" || Number.isNaN(Date.parse(word.created_at)))
  )
    throw new Error("Invalid creation time.");
  const fields = word.created_at === undefined ? columns : [...columns, "created_at"];
  // Preserve an existing D1 identity and any progress that refers to it.
  return `INSERT INTO words (${fields.join(",")}) VALUES (${fields.map((col) => quote(word[col])).join(",")}) ON CONFLICT(lang,text,gloss) DO UPDATE SET gloss_lang=excluded.gloss_lang,hint=excluded.hint,image=excluded.image,kind=excluded.kind,freq_rank=excluded.freq_rank${word.created_at === undefined ? "" : ",created_at=excluded.created_at"};`;
});
const directory = await mkdtemp(join(tmpdir(), "vocab-words-"));
try {
  const file = join(directory, "words.sql");
  await writeFile(file, statements.join("\n"));
  execFileSync(
    "bun",
    ["run", "wrangler", "d1", "execute", "DB", remote ? "--remote" : "--local", "--file", file],
    { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit" },
  );
  console.log(`Imported ${words.length} words. No progress or authentication data was changed.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
