import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { parseCatalogue } from "./contract";
import type { Candidate } from "./extract";
import { LEXIQUE_SHA256, LEXIQUE_URL } from "./extract";

const Curation = v.array(
  v.strictObject({
    cue: v.string(),
    lemma: v.string(),
    meaning: v.string(),
    note: v.nullable(v.string()),
  })
);
export const stableId = (namespace: string, key: string) =>
  `${namespace}:${createHash("sha256").update(key.normalize("NFC")).digest("hex").slice(0, 24)}`;

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "../../../..");
  const candidates: Candidate[] = JSON.parse(
    await readFile(path.join(root, ".cache/catalogue/candidates.json"), "utf-8")
  );
  const batches = await Promise.all(
    [1, 2, 3, 4].map(async (n) =>
      v.parse(
        Curation,
        JSON.parse(
          await readFile(
            new URL(`curation-${n}.json`, import.meta.url),
            "utf-8"
          )
        )
      )
    )
  );
  const curated = batches.flat();
  const byLemma = new Map(curated.map((row) => [row.lemma, row]));
  if (
    curated.length !== 1000 ||
    byLemma.size !== curated.length ||
    candidates.length !== 1000
  ) {
    throw new Error("Expected exactly 1000 unique candidates and cue records.");
  }
  const pronominal = new Map([
    ["enfuir", "s'enfuir"],
    ["moquer", "se moquer"],
    ["souvenir", "se souvenir"],
  ]);
  const data = parseCatalogue({
    cue_source: {
      id: "fr-it-editorial-pilot-v1",
      license: "Project-authored content",
      sha256: createHash("sha256")
        .update(JSON.stringify(curated))
        .digest("hex"),
      title:
        "Model-authored local pilot meanings and Italian cues; not dictionary-verified",
      url: "local:curation-1.json..curation-4.json",
      version: "1",
    },
    entries: candidates.map((candidate) => {
      const row = byLemma.get(candidate.lemma);
      if (!row) {
        throw new Error(`Missing curation: ${candidate.lemma}`);
      }
      const entry = stableId("fr-lemma", candidate.lemma);
      const sense = `${entry}:primary-v1`;
      const target = pronominal.get(candidate.lemma) ?? candidate.lemma;
      return {
        forms: candidate.forms,
        frequencies: candidate.frequencies.map((f) => ({
          part_of_speech: f.partOfSpeech,
          per_million: f.perMillion,
        })),
        frequency_per_million: candidate.frequency,
        frequency_rank: candidate.rank,
        frequency_warnings: candidate.frequencyWarnings,
        gender: candidate.gender,
        id: entry,
        kind: "word",
        language: "fr",
        morphology: candidate.morphology,
        pronunciation: candidate.pronunciation,
        sense: {
          description: row.meaning,
          id: sense,
          part_of_speech: candidate.partOfSpeech,
          prompt: {
            cue: row.cue,
            expected_answer: target,
            id: `${sense}:it:v1`,
            language: "it",
            reveal_note: row.note,
            status: "machine_draft",
            version: 1,
          },
        },
        source_key: candidate.lemma,
        text: target,
      };
    }),
    id: "fr-lexique4-it-1000-v1",
    language: "fr",
    lexical_source: {
      id: "lexique-4.00",
      license: "CC-BY-SA-4.0",
      sha256: LEXIQUE_SHA256,
      title: "Lexique 4.00",
      url: LEXIQUE_URL,
      version: "4.00",
    },
    prompt_language: "it",
    ranking_policy:
      "lexique4-canonical-lemma-pos-sum-v1: descending sum across eligible POS; canonical rows only; ties use Unicode lemma order; excluded function categories, reviewed particles/annotation anomalies and multiword forms; unresolved frequency inconsistencies explicitly flagged",
    schema_version: 1,
    title: "French: first 1000 eligible Lexique 4 lemmas (Italian cues)",
  });
  await writeFile(
    new URL("fr-it-1000.json", import.meta.url),
    `${JSON.stringify(data, null, 2)}\n`
  );
  console.log(
    `Built ${data.entries.length} ranked lemma targets. Cues are machine drafts for local evaluation, not human-reviewed publication.`
  );
}
