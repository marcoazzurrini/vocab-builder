import { createHash } from "node:crypto";

import { parseCatalogue } from "./contract";
import type { Catalogue } from "./contract";

export interface Statement {
  sql: string;
  params: (string | number | null)[];
}
const insert = (
  table: string,
  values: Record<string, string | number | null>,
  conflict = ""
): Statement => ({
  params: Object.values(values),
  sql: `INSERT INTO ${table} (${Object.keys(values).join(",")}) VALUES (${Object.keys(
    values
  )
    .map(() => "?")
    .join(",")}) ${conflict}`,
});
const immutableUpsert = (key: string, columns: string[]) =>
  `ON CONFLICT(${key}) DO UPDATE SET ${columns.map((c) => `${c}=excluded.${c}`).join(",")}`;

// Deliberately conservative editorial relationships, not transitive morphology/stemming.
// They organize coverage only; each lemma remains an independent production target.
const familyGroups = [
  ["travail", "travailler"],
  ["aide", "aider"],
  ["appel", "appeler", "rappeler"],
  ["changement", "changer"],
  ["choix", "choisir"],
  ["réponse", "répondre"],
  ["chanson", "chanter", "chanteur"],
  ["danse", "danser"],
  ["jeu", "jouer", "joueur"],
  ["danger", "dangereux"],
  ["différence", "différent"],
  ["importance", "important"],
  ["vrai", "vraiment"],
  ["simple", "simplement"],
  ["facile", "facilement"],
  ["exact", "exactement"],
  ["certain", "certainement"],
  ["possible", "impossible"],
  ["heureux", "malheureux"],
  ["libre", "liberté"],
  ["calme", "calmer"],
  ["attaque", "attaquer"],
  ["visite", "visiter"],
  ["marche", "marcher"],
  ["mort", "mourir"],
  ["naître", "naissance"],
  ["mariage", "marier", "marié"],
  ["sérieux", "sérieusement"],
  ["normal", "normalement"],
  ["personne", "personnel"],
  ["sûr", "sûrement"],
  ["fin", "finir"],
  ["perte", "perdre"],
  ["vente", "vendre"],
];

/** Prepared statements are executed in ONE transactional D1 batch. Never execute piecemeal. */
export const compileCatalogue = (
  input: Catalogue,
  options: { allowDrafts?: boolean; activate?: boolean } = {}
) => {
  const data = parseCatalogue(input);
  if (
    !options.allowDrafts &&
    data.entries.some((e) => e.sense.prompt.status !== "reviewed")
  ) {
    throw new Error(
      "Unreviewed content requires explicit --allow-drafts for the local pilot."
    );
  }
  const statements: Statement[] = [];
  for (const source of [data.lexical_source, data.cue_source]) {
    statements.push(
      insert(
        "catalogue_sources",
        source,
        immutableUpsert("id", ["title", "version", "url", "license", "sha256"])
      )
    );
  }
  statements.push(
    insert(
      "catalogue_lists",
      {
        id: data.id,
        is_default: 0,
        language: data.language,
        prompt_language: data.prompt_language,
        ranking_policy: data.ranking_policy,
        source_id: data.lexical_source.id,
        title: data.title,
      },
      immutableUpsert("id", [
        "title",
        "language",
        "prompt_language",
        "ranking_policy",
        "source_id",
      ])
    )
  );
  for (const entry of data.entries) {
    const { prompt } = entry.sense;
    statements.push(
      insert(
        "lexical_entries",
        {
          annotations: JSON.stringify({
            frequency_warnings: entry.frequency_warnings,
            gender: entry.gender,
            morphology: entry.morphology,
            pronunciation: entry.pronunciation,
          }),
          forms: JSON.stringify(entry.forms),
          id: entry.id,
          kind: entry.kind,
          language: entry.language,
          source_id: data.lexical_source.id,
          source_key: entry.source_key,
          text: entry.text,
        },
        immutableUpsert("id", [
          "language",
          "text",
          "kind",
          "source_id",
          "source_key",
          "forms",
          "annotations",
        ])
      ),
      insert(
        "catalogue_senses",
        {
          description: entry.sense.description,
          entry_id: entry.id,
          id: entry.sense.id,
          part_of_speech: entry.sense.part_of_speech,
          source_id: data.cue_source.id,
        },
        immutableUpsert("id", [
          "entry_id",
          "description",
          "part_of_speech",
          "source_id",
        ])
      )
    );
    for (const f of entry.frequencies) {
      statements.push(
        insert(
          "catalogue_frequencies",
          {
            entry_id: entry.id,
            part_of_speech: f.part_of_speech,
            per_million: f.per_million,
            source_id: data.lexical_source.id,
            unit: "lemma-pos",
          },
          "ON CONFLICT(entry_id,source_id,unit,part_of_speech) DO UPDATE SET per_million=excluded.per_million"
        )
      );
    }
    statements.push(
      insert(
        "words",
        {
          freq_rank: entry.frequency_rank,
          gloss: prompt.cue,
          gloss_lang: prompt.language,
          hint: prompt.reveal_note,
          id: prompt.id,
          image: null,
          kind: entry.kind,
          lang: entry.language,
          text: entry.text,
        },
        "ON CONFLICT(lang,text,gloss,gloss_lang) DO UPDATE SET freq_rank=excluded.freq_rank"
      )
    );
    const projection =
      "(SELECT id FROM words WHERE lang=? AND text=? AND gloss=? AND gloss_lang=?)";
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          entry.language,
          entry.text,
          prompt.language,
          prompt.cue,
          prompt.reveal_note,
        ])
      )
      .digest("hex");
    statements.push(
      {
        params: [
          prompt.id,
          entry.language,
          entry.text,
          prompt.cue,
          prompt.language,
          entry.sense.id,
          prompt.language,
          prompt.version,
          prompt.status,
          data.cue_source.id,
          hash,
        ],
        sql: `INSERT INTO catalogue_prompts (id,word_id,sense_id,language,version,cue_type,status,source_id,content_hash) VALUES (?,${projection},?,?,?,'text',?,?,?) ON CONFLICT(id) DO UPDATE SET word_id=excluded.word_id,sense_id=excluded.sense_id,language=excluded.language,version=excluded.version,cue_type=excluded.cue_type,status=excluded.status,source_id=excluded.source_id,content_hash=excluded.content_hash`,
      },
      insert(
        "catalogue_list_members",
        {
          frequency_rank: entry.frequency_rank,
          list_id: data.id,
          position: entry.frequency_rank,
          sense_id: entry.sense.id,
        },
        "ON CONFLICT(list_id,sense_id) DO UPDATE SET position=excluded.position,frequency_rank=excluded.frequency_rank"
      )
    );
  }
  const byText = new Map(data.entries.map((e) => [e.text, e]));
  let families = 0;
  let familyMembers = 0;
  for (const group of familyGroups) {
    const entries = group.flatMap((text) => {
      const e = byText.get(text);
      return e ? [e] : [];
    });
    if (entries.length < 2) {
      continue;
    }
    const [label] = group;
    if (!label) {
      continue;
    }
    const id = `fr-editorial-family:${label}`;
    statements.push(
      insert(
        "catalogue_families",
        {
          id,
          label,
          language: data.language,
          policy:
            "conservative-editorial-derivation-v1; model-authored, not a complete or externally validated family taxonomy",
          source_id: data.cue_source.id,
        },
        "ON CONFLICT(id) DO NOTHING"
      )
    );
    for (const e of entries) {
      statements.push(
        insert(
          "catalogue_family_members",
          { entry_id: e.id, family_id: id },
          "ON CONFLICT(family_id,entry_id) DO NOTHING"
        )
      );
    }
    families += 1;
    familyMembers += entries.length;
  }
  if (options.activate) {
    statements.push(
      {
        params: [data.language, data.prompt_language],
        sql: "UPDATE catalogue_lists SET is_default=0 WHERE language=? AND prompt_language=?",
      },
      {
        params: [data.id],
        sql: "UPDATE catalogue_lists SET is_default=1 WHERE id=?",
      }
    );
  }
  return { data, families, familyMembers, statements };
};
