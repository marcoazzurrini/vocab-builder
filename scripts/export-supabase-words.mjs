import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Read-only export. Credentials stay in process environment, never in the browser or output.
const baseURL = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseURL || !key)
  throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for this read-only export.");
const output = process.argv[2] ?? "exports/words.json";
const words = [];
const pageSize = 500;
let total;
for (let offset = 0; ;) {
  const url = new URL("/rest/v1/words", baseURL);
  url.searchParams.set(
    "select",
    "id,lang,text,gloss,gloss_lang,hint,image,kind,freq_rank,created_at",
  );
  url.searchParams.set("order", "id.asc");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(pageSize));
  const response = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
  });
  if (!response.ok) throw new Error(`Word export failed (${response.status}). No output written.`);
  const count = Number(response.headers.get("content-range")?.split("/")[1]);
  if (!Number.isInteger(count) || count < 0)
    throw new Error("The source did not return an exact row count.");
  if (total !== undefined && total !== count)
    throw new Error("The catalogue changed during export. Retry while it is not being edited.");
  total = count;
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Unexpected export response.");
  words.push(...rows);
  offset += rows.length;
  if (offset === total) break;
  if (!rows.length || offset > total) throw new Error("Incomplete export. No output written.");
}
if (!words.length) throw new Error("Source catalogue is empty. No output written.");
if (new Set(words.map((word) => word.id)).size !== words.length)
  throw new Error("Duplicate IDs in export; retry while the catalogue is not being edited.");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(words, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`Exported ${words.length} words to ${output}. Supabase was not modified.`);
