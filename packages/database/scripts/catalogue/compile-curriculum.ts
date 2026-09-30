import { stableId } from "./build";
import type { Statement } from "./compile";
import { validateCurriculum } from "./curriculum";
import type { Curriculum } from "./curriculum";
import type { FamilyResource } from "./families";
import { contentHash as hash } from "./hash";
import {
  PRESENTATION_VERSION,
  presentationFor,
  presentationSourceHash,
} from "./presentations";

const insert = (
  table: string,
  values: Record<string, string | number | null>,
  key = "id"
): Statement => {
  const columns = Object.keys(values);
  return {
    params: Object.values(values),
    sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) ON CONFLICT(${key}) DO UPDATE SET ${columns.map((c) => `${c}=excluded.${c}`).join(",")}`,
  };
};
export const compileCurriculum = (
  resource: FamilyResource,
  curriculum: Curriculum,
  options: {
    allowDrafts?: boolean;
    activate?: boolean;
    expectedFamilyCount?: number;
  } = {}
) => {
  validateCurriculum(resource, curriculum);
  const expected = options.expectedFamilyCount ?? 1000;
  if (resource.families.length !== expected) {
    throw new Error(
      `Expected ${expected} families, received ${resource.families.length}`
    );
  }
  if (
    !options.allowDrafts &&
    curriculum.steps.some((s) => s.status !== "reviewed")
  ) {
    throw new Error(
      "Machine-authored cues require explicit --allow-drafts for personal evaluation."
    );
  }
  const statements: Statement[] = [];
  statements.push(
    insert("catalogue_sources", {
      id: resource.source.id,
      license: "CC-BY-SA-4.0",
      sha256: resource.source.sha256,
      title: "Lexique 4.00",
      url: resource.source.url,
      version: "4.00",
    }),
    insert("catalogue_sources", {
      id: resource.id,
      license: "CC-BY-SA-4.0; editorial family policy in project source",
      sha256: hash(resource),
      title: "French 1000 frequency-selected word families",
      url: "local:family-resource.json",
      version: "1",
    })
  );
  for (const source of curriculum.sources) {
    statements.push(insert("catalogue_sources", source));
  }
  const presentationSourceId = `fr-it-dictionary-v${PRESENTATION_VERSION}`;
  statements.push(
    insert("catalogue_sources", {
      id: presentationSourceId,
      license:
        "Project-authored teaching copy; independent language review pending",
      sha256: presentationSourceHash,
      title: "French–Italian dictionary presentation",
      url: "local:presentations.ts",
      version: String(PRESENTATION_VERSION),
    })
  );
  const lemmas = new Map(resource.lemmas.map((c) => [c.lemma, c]));
  const baseSteps = new Map(
    curriculum.steps.filter((s) => !s.form_id).map((s) => [s.lemma, s])
  );
  for (const c of resource.lemmas) {
    const step = baseSteps.get(c.lemma);
    if (!step) {
      throw new Error(`Missing base target: ${c.lemma}`);
    }
    statements.push(
      insert("lexical_entries", {
        annotations: JSON.stringify({
          frequency_warnings: c.frequencyWarnings,
          gender: c.gender,
          morphology: c.morphology,
          pronunciation: c.pronunciation,
        }),
        forms: JSON.stringify(c.forms),
        id: step.entry_id,
        kind: "word",
        language: curriculum.language,
        source_id: resource.source.id,
        source_key: c.lemma,
        text: step.text,
      })
    );
    for (const f of c.frequencies) {
      statements.push(
        insert(
          "catalogue_frequencies",
          {
            entry_id: step.entry_id,
            part_of_speech: f.partOfSpeech,
            per_million: f.perMillion,
            source_id: resource.source.id,
            unit: "lemma-pos",
          },
          "entry_id,source_id,unit,part_of_speech"
        )
      );
    }
  }
  for (const family of resource.families) {
    statements.push(
      insert("catalogue_families", {
        id: family.id,
        label: family.label,
        language: curriculum.language,
        policy: resource.policy,
        source_id: resource.id,
      }),
      insert(
        "catalogue_family_ranks",
        {
          family_id: family.id,
          per_million: family.per_million,
          rank: family.rank,
          resource_id: resource.id,
        },
        "resource_id,family_id"
      )
    );
    for (const lemma of family.lemmas) {
      if (!lemmas.has(lemma)) {
        throw new Error(`Unknown family lemma: ${lemma}`);
      }
      statements.push(
        insert(
          "catalogue_family_members",
          {
            entry_id: stableId("fr-lemma", lemma),
            family_id: family.id,
          },
          "family_id,entry_id"
        )
      );
    }
  }
  for (const form of resource.forms) {
    statements.push(
      insert("catalogue_forms", {
        entry_id: stableId("fr-lemma", form.lemma),
        gender: form.gender,
        id: form.id,
        number: form.number,
        part_of_speech: form.part_of_speech,
        per_million: form.per_million,
        source_id: resource.source.id,
        text: form.text,
        verb_info: form.verb_info,
      })
    );
  }
  statements.push(
    insert("catalogue_lists", {
      id: curriculum.id,
      language: curriculum.language,
      prompt_language: curriculum.prompt_language,
      ranking_policy: curriculum.policy,
      source_id: resource.id,
      title: curriculum.title,
    }),
    insert("catalogue_curricula", {
      content_hash: hash(curriculum),
      id: curriculum.id,
      resource_id: resource.id,
    })
  );
  for (const step of curriculum.steps) {
    statements.push(
      insert("catalogue_senses", {
        description: step.description,
        entry_id: step.entry_id,
        id: step.sense_id,
        part_of_speech: step.part_of_speech,
        source_id: step.cue_source_id,
      }),
      // Exact existing matches keep IDs and historical hints. Explanations are
      // teaching/feedback content, never answer-bearing recall hints.
      {
        params: [
          step.prompt_id,
          curriculum.language,
          step.text,
          step.cue,
          curriculum.prompt_language,
          step.position,
          step.note,
        ],
        sql: "INSERT INTO words (id,lang,text,gloss,gloss_lang,kind,freq_rank,hint,image) VALUES (?,?,?,?,?,'word',?,?,NULL) ON CONFLICT(lang,text,gloss,gloss_lang) DO UPDATE SET freq_rank=excluded.freq_rank",
      }
    );
    const projection =
      "(SELECT id FROM words WHERE lang=? AND text=? AND gloss=? AND gloss_lang=?)";
    statements.push(
      {
        params: [
          step.prompt_id,
          curriculum.language,
          step.text,
          step.cue,
          curriculum.prompt_language,
          step.sense_id,
          curriculum.prompt_language,
          step.status,
          step.cue_source_id,
          hash([
            curriculum.language,
            step.text,
            curriculum.prompt_language,
            step.cue,
            step.note,
          ]),
        ],
        sql: `INSERT INTO catalogue_prompts (id,word_id,sense_id,language,version,cue_type,status,source_id,content_hash) VALUES (?,${projection},?,?,1,'text',?,?,?) ON CONFLICT(id) DO UPDATE SET word_id=excluded.word_id,sense_id=excluded.sense_id,language=excluded.language,source_id=excluded.source_id,content_hash=excluded.content_hash,status=excluded.status`,
      },
      insert(
        "catalogue_presentations",
        {
          content: JSON.stringify(presentationFor(step)),
          prompt_id: step.prompt_id,
          source_id: presentationSourceId,
          version: PRESENTATION_VERSION,
        },
        "prompt_id,version"
      ),
      insert(
        "catalogue_list_members",
        {
          frequency_rank: step.family_rank,
          list_id: curriculum.id,
          position: step.position,
          sense_id: step.sense_id,
        },
        "list_id,sense_id"
      ),
      insert(
        "catalogue_curriculum_steps",
        {
          curriculum_id: curriculum.id,
          entry_id: step.entry_id,
          family_id: step.family_id,
          form_id: step.form_id,
          id: step.id,
          position: step.position,
          prerequisite: step.prerequisite,
          prompt_id: step.prompt_id,
        },
        "curriculum_id,id"
      )
    );
  }
  if (options.activate) {
    statements.push(
      {
        params: [curriculum.language, curriculum.prompt_language],
        sql: "UPDATE catalogue_lists SET is_default=0 WHERE language=? AND prompt_language=?",
      },
      {
        params: [curriculum.id],
        sql: "UPDATE catalogue_lists SET is_default=1 WHERE id=?",
      }
    );
  }
  return {
    data: {
      contentHash: hash(curriculum),
      id: curriculum.id,
      resourceHash: hash(resource),
      sourceId: resource.source.id,
    },
    families: resource.families.length,
    familyMembers: resource.lemmas.length,
    forms: resource.forms.length,
    statements,
    targets: curriculum.steps.length,
  };
};
