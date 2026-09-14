import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compileCatalogue } from "./catalogue";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { config: { type: "string" }, remote: { type: "boolean", default: false } },
});
if (!values.config)
  throw new Error("Provide --config with the target Worker's Wrangler configuration.");
if (positionals.length > 1) throw new Error("Provide at most one catalogue file.");
const source = positionals[0] ?? new URL("../seed/words.json", import.meta.url);
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
  console.log(`Imported ${catalogue.count} words. No progress or authentication data was changed.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
