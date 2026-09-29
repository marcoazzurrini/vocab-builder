import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const LEXIQUE_URL =
  "https://www.lexique.org/databases/Lexique400/Lexique400.zip";
export const LEXIQUE_SHA256 =
  "8ed5a64373ae798f0485a2a35848c09286b6694c6859abeaab6806594c046993";
const allowed = new Set(["NOM", "VER", "ADJ", "ADV", "ADJ:num"]);
// These grammatical particles cannot be elicited honestly by an isolated meaning cue.
export const excluded = new Set([
  "ne",
  "pas",
  "n'",
  "en",
  "y",
  "ci",
  "avec",
  "sur",
  "quelque",
  "depuis",
  "comme",
  // Annotation/homograph anomalies reviewed against source rows; not trustworthy priorities.
  "upas",
  "ca",
  "rob",
  "déesse",
  "garce",
  "garçonne",
  "cieux",
]);

export interface Candidate {
  lemma: string;
  rank: number;
  frequency: number;
  partOfSpeech: string;
  frequencies: { partOfSpeech: string; perMillion: number }[];
  forms: string[];
  morphology: { base: string; structure: string; decomposition: string } | null;
  pronunciation: string | null;
  gender: string | null;
  frequencyWarnings: string[];
}

const validateHeaders = (headers: string[]) => {
  for (const name of [
    "1_Mot",
    "4_Lemme",
    "5_Cgram",
    "12_FreqLemme",
    "14_IsLem",
  ]) {
    if (!headers.includes(name)) {
      throw new Error(`Missing Lexique column: ${name}`);
    }
  }
};

const isEligibleLemma = (lemma: string, pos: string) =>
  allowed.has(pos) &&
  !excluded.has(lemma) &&
  /^[\p{L}][\p{L}’'-]*$/u.test(lemma) &&
  lemma.length >= 2;

/** Use canonical rows only: Lexique's inflection rows sometimes repeat inconsistent lemma totals. */
export const extractCandidates = (tsv: string, limit?: number): Candidate[] => {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("Invalid candidate limit.");
  }
  const lines = tsv
    .replace(/^\uFEFF/u, "")
    .trimEnd()
    .split(/\r?\n/u);
  const headers = lines.shift()?.split("\t") ?? [];
  validateHeaders(headers);
  const grouped = new Map<
    string,
    { observations: Map<string, number>; rows: Record<string, string>[] }
  >();
  for (const line of lines) {
    const cells = line.split("\t");
    const row = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
    const lemma = (row["4_Lemme"] ?? "").normalize("NFC");
    const pos = row["5_Cgram"] ?? "";
    if (!isEligibleLemma(lemma, pos)) {
      continue;
    }
    const frequency = Number(row["12_FreqLemme"]);
    if (!Number.isFinite(frequency) || frequency < 0) {
      throw new Error(`Invalid frequency: ${lemma}`);
    }
    const group = grouped.get(lemma) ?? {
      observations: new Map<string, number>(),
      rows: [],
    };
    if (row["14_IsLem"] === "1") {
      const old = group.observations.get(pos);
      if (old !== undefined && old !== frequency) {
        throw new Error(`Conflicting canonical frequencies: ${lemma}/${pos}`);
      }
      group.observations.set(pos, frequency);
    }
    group.rows.push(row);
    grouped.set(lemma, group);
  }
  const candidates = [...grouped]
    .filter(([, group]) => group.observations.size > 0)
    .map(([lemma, group]) => {
      const frequencies = [...group.observations]
        .map(([partOfSpeech, perMillion]) => ({ partOfSpeech, perMillion }))
        .toSorted(
          (a, b) =>
            b.perMillion - a.perMillion ||
            a.partOfSpeech.localeCompare(b.partOfSpeech, "en")
        );
      const [first] = frequencies;
      if (!first) {
        return null;
      }
      const primary = group.rows.find(
        (r) => r["14_IsLem"] === "1" && r["5_Cgram"] === first.partOfSpeech
      );
      if (!primary) {
        return null;
      }
      return {
        forms: [...new Set(group.rows.map((r) => r["1_Mot"] ?? ""))].toSorted(),
        frequencies,
        frequency: Number(
          frequencies.reduce((n, f) => n + f.perMillion, 0).toFixed(3)
        ),
        frequencyWarnings: frequencies.flatMap((f) => {
          const values = group.rows
            .filter((r) => r["5_Cgram"] === f.partOfSpeech)
            .map((r) => Number(r["12_FreqLemme"]));
          const min = Math.min(...values);
          const max = Math.max(...values);
          return min === max
            ? []
            : [
                `${f.partOfSpeech}: source lemma totals disagree (${min}..${max}); canonical observation retained, not corrected`,
              ];
        }),
        gender: primary["7_Genre"] || null,
        lemma,
        morphology: primary["30_MorphoBase"]
          ? {
              base: primary["30_MorphoBase"],
              decomposition: primary["32_MorphoDecomp"] ?? "",
              structure: primary["31_MorphoStruct"] ?? "",
            }
          : null,
        partOfSpeech: first.partOfSpeech,
        pronunciation: primary["3_Phono_IPA"] || null,
      };
    })
    .filter((c) => c !== null)
    .filter((c) => c.frequency > 0)
    .toSorted(
      (a, b) => b.frequency - a.frequency || (a.lemma < b.lemma ? -1 : 1)
    );
  if (limit !== undefined && candidates.length < limit) {
    throw new Error("Not enough eligible lemmas.");
  }
  return candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));
};

if (import.meta.main) {
  const directory = path.resolve(
    import.meta.dirname,
    "../../../../.cache/catalogue"
  );
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, "Lexique400.zip");
  let bytes: Uint8Array;
  try {
    bytes = await readFile(archive);
  } catch {
    const response = await fetch(LEXIQUE_URL);
    if (!response.ok) {
      throw new Error(`Lexique download failed: ${response.status}`);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== LEXIQUE_SHA256) {
    throw new Error(
      "Lexique archive changed; audit it before updating the pinned hash."
    );
  }
  await writeFile(archive, bytes);
  const tsv = execFileSync("unzip", ["-p", archive, "Lexique4/Lexique4.tsv"], {
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const candidates = extractCandidates(tsv, 1000);
  await writeFile(
    path.join(directory, "candidates.json"),
    `${JSON.stringify(candidates, null, 2)}\n`
  );
  console.log(
    `Extracted ${candidates.length} ranked lemmas to ${directory}/candidates.json`
  );
}
