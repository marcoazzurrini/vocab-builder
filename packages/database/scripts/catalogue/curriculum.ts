import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { stableId } from "./build";
import { parseCatalogue } from "./contract";
import type { Catalogue } from "./contract";
import { LEXIQUE_SHA256 } from "./extract";
import type { Candidate } from "./extract";
import { extractFamilyResource, validateFamilyResource } from "./families";
import type { Family, FamilyResource, FormObservation } from "./families";
import { contentHash } from "./hash";

export interface CurriculumStep {
  id: string;
  family_id: string;
  entry_id: string;
  form_id: string | null;
  lemma: string;
  text: string;
  sense_id: string;
  description: string;
  part_of_speech: string;
  prompt_id: string;
  cue: string;
  note: string | null;
  cue_source_id: string;
  status: "machine_draft" | "reviewed";
  position: number;
  family_rank: number;
  // Scheduling priority is editorial, not a replacement for the source frequency.
  prerequisite: string | null;
}
export interface Curriculum {
  schema_version: 1;
  id: string;
  resource_id: string;
  resource_sha256: string;
  title: string;
  language: "fr";
  prompt_language: "it";
  policy: string;
  sources: Catalogue["cue_source"][];
  steps: CurriculumStep[];
}
const CurationRowSchema = v.strictObject({
  cue: v.string(),
  lemma: v.string(),
  meaning: v.string(),
  note: v.nullable(v.string()),
});
export type CurationRow = v.InferOutput<typeof CurationRowSchema>;

// Selected, useful present-tense forms. Each remains an individual vocabulary
// memory; learning a lemma or sibling form never marks these forms learned.
export const formLessons = [
  ["être", "suis", "sono (io; verbo essere)", "Con il soggetto je: je suis."],
  ["être", "es", "sei (tu; verbo essere)", "Con il soggetto tu: tu es."],
  ["être", "est", "è (lui/lei; verbo essere)", "Il est oppure elle est."],
  ["être", "sommes", "siamo (noi; verbo essere)", "Nous sommes."],
  [
    "être",
    "êtes",
    "siete (voi; verbo essere)",
    "Vous êtes; anche con il vous di cortesia.",
  ],
  ["être", "sont", "sono (loro; verbo essere)", "Ils sont oppure elles sont."],
  ["avoir", "ai", "ho (io; verbo avere)", "Con je si elide: j'ai."],
  ["avoir", "as", "hai (tu; verbo avere)", "Tu as."],
  [
    "avoir",
    "a",
    "ha (lui/lei; verbo avere)",
    "Il a oppure elle a. Senza accento: à è una preposizione.",
  ],
  ["avoir", "avons", "abbiamo (noi; verbo avere)", "Nous avons."],
  ["avoir", "avez", "avete (voi; verbo avere)", "Vous avez."],
  ["avoir", "ont", "hanno (loro; verbo avere)", "Ils ont oppure elles ont."],
  ["aller", "vais", "vado (io; verbo andare)", "Je vais."],
  ["aller", "vas", "vai (tu; verbo andare)", "Tu vas."],
  ["aller", "va", "si reca (lui/lei; verbo andare)", "Il va oppure elle va."],
  ["aller", "allons", "andiamo (noi; verbo andare)", "Nous allons."],
  ["aller", "allez", "andate (voi; verbo andare)", "Vous allez."],
  [
    "aller",
    "vont",
    "vanno (loro; verbo andare)",
    "Ils vont oppure elles vont.",
  ],
  [
    "faire",
    "fais",
    "faccio (io; verbo fare)",
    "Je fais. La stessa grafia si usa con tu.",
  ],
  ["faire", "fait", "fa (lui/lei; verbo fare)", "Il fait oppure elle fait."],
  ["faire", "faisons", "facciamo (noi; verbo fare)", "Nous faisons."],
  ["faire", "font", "fanno (loro; verbo fare)", "Ils font oppure elles font."],
  ["pouvoir", "peux", "posso (io; verbo potere)", "Je peux. Anche tu peux."],
  [
    "pouvoir",
    "peut",
    "può (lui/lei; verbo potere)",
    "Il peut oppure elle peut.",
  ],
  ["vouloir", "veux", "voglio (io; verbo volere)", "Je veux. Anche tu veux."],
  [
    "vouloir",
    "veut",
    "vuole (lui/lei; verbo volere)",
    "Il veut oppure elle veut.",
  ],
  ["savoir", "sais", "so (io; verbo sapere)", "Je sais. Anche tu sais."],
  ["savoir", "sait", "sa (lui/lei; verbo sapere)", "Il sait oppure elle sait."],
  ["venir", "viens", "vengo (io; verbo venire)", "Je viens. Anche tu viens."],
  [
    "prendre",
    "prends",
    "prendo (io; verbo prendere)",
    "Je prends. Anche tu prends.",
  ],
  ["voir", "vois", "vedo (io; verbo vedere)", "Je vois. Anche tu vois."],
  ["dire", "dis", "dico (io; verbo dire)", "Je dis. Anche tu dis."],
  [
    "parler",
    "parle",
    "parlo (io; presente di parlare)",
    "Je parle. Nei verbi regolari in -er, con je la desinenza del presente è -e.",
  ],
  [
    "aimer",
    "aime",
    "amo (io; presente di amare)",
    "J'aime. Con una vocale iniziale, je diventa j'.",
  ],
  [
    "penser",
    "pense",
    "penso (io; presente di pensare)",
    "Je pense. La desinenza del presente con je è -e.",
  ],
] as const;

const getLemmaContent = (
  candidate: Candidate,
  old: Catalogue["entries"][number] | undefined,
  row: CurationRow | undefined
): Pick<
  CurriculumStep,
  "cue" | "description" | "note" | "part_of_speech" | "status" | "text"
> => ({
  cue: old?.sense.prompt.cue ?? row?.cue ?? "",
  description: old?.sense.description ?? row?.meaning ?? "",
  note: old?.sense.prompt.reveal_note ?? row?.note ?? null,
  part_of_speech: old?.sense.part_of_speech ?? candidate.partOfSpeech,
  status: old?.sense.prompt.status ?? "machine_draft",
  text: old?.text ?? candidate.lemma,
});

const validateStepMembership = (
  step: CurriculumStep,
  families: Map<string, Family>,
  forms: Map<string, FormObservation>
) => {
  const family = families.get(step.family_id);
  if (
    !family?.lemmas.includes(step.lemma) ||
    step.family_rank !== family.rank ||
    step.entry_id !== stableId("fr-lemma", step.lemma)
  ) {
    throw new Error("Curriculum family membership mismatch");
  }
  if (step.form_id) {
    const form = forms.get(step.form_id);
    if (
      form?.lemma !== step.lemma ||
      form.text !== step.text ||
      form.part_of_speech !== step.part_of_speech
    ) {
      throw new Error("Curriculum form mismatch");
    }
  }
};

export const validateCurriculum = (
  resource: FamilyResource,
  curriculum: Curriculum
) => {
  validateFamilyResource(resource);
  const ids = new Set<string>();
  const prompts = new Set<string>();
  const families = new Map(resource.families.map((f) => [f.id, f]));
  const covered = new Set<string>();
  const forms = new Map(resource.forms.map((f) => [f.id, f]));
  if (
    curriculum.schema_version !== 1 ||
    curriculum.language !== "fr" ||
    curriculum.prompt_language !== "it" ||
    curriculum.resource_id !== resource.id ||
    curriculum.resource_sha256 !== contentHash(resource)
  ) {
    throw new Error("Curriculum/resource identity mismatch");
  }
  for (const [i, s] of curriculum.steps.entries()) {
    validateStepMembership(s, families, forms);
    if (
      ids.has(s.id) ||
      prompts.has(s.prompt_id) ||
      s.position !== i + 1 ||
      (s.prerequisite && !ids.has(s.prerequisite))
    ) {
      throw new Error(
        "Invalid curriculum order, duplicate identity or missing prerequisite"
      );
    }
    const cueWords = s.cue
      .normalize("NFC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u);
    if (
      !s.cue.trim() ||
      !s.description.trim() ||
      cueWords.includes(s.text.normalize("NFC").toLowerCase())
    ) {
      throw new Error("Empty or answer-leaking cue");
    }
    if (!curriculum.sources.some((source) => source.id === s.cue_source_id)) {
      throw new Error("Missing cue source");
    }
    ids.add(s.id);
    prompts.add(s.prompt_id);
    covered.add(s.family_id);
  }
  if (covered.size !== families.size) {
    throw new Error("Curriculum does not cover every selected family");
  }
};

export const buildCurriculum = (
  resource: FamilyResource,
  legacy: Catalogue,
  extra: CurationRow[]
): Curriculum => {
  const byLemma = new Map(legacy.entries.map((e) => [e.source_key, e]));
  const additions = new Map(extra.map((e) => [e.lemma, e]));
  if (additions.size !== extra.length) {
    throw new Error("Duplicate editorial lemma");
  }
  const source: Catalogue["cue_source"] = {
    id: "fr-it-family-curriculum-editorial-v1",
    license: "Project-authored content",
    sha256: contentHash([extra, formLessons]),
    title:
      "Project-authored family curriculum and selected form cues; machine-reviewed local dogfood",
    url: "local:curation-families.json+curriculum.ts",
    version: "1",
  };
  const familyByLemma = new Map(
    resource.families.flatMap((f) =>
      f.lemmas.map((lemma) => [lemma, f] as const)
    )
  );
  const steps: CurriculumStep[] = resource.lemmas.map((c) => {
    const family = familyByLemma.get(c.lemma);
    if (!family) {
      throw new Error(`Missing family: ${c.lemma}`);
    }
    const old = byLemma.get(c.lemma);
    const row = additions.get(c.lemma);
    if (!old && !row) {
      throw new Error(`Missing Italian curation: ${c.lemma}`);
    }
    const entryId = old?.id ?? stableId("fr-lemma", c.lemma);
    const senseId = old?.sense.id ?? `${entryId}:primary-v1`;
    const content = getLemmaContent(c, old, row);
    return {
      cue: content.cue,
      cue_source_id: old ? legacy.cue_source.id : source.id,
      description: content.description,
      entry_id: entryId,
      family_id: family.id,
      family_rank: family.rank,
      form_id: null,
      id: stableId("curriculum-step", `${senseId}:it:v1`),
      lemma: c.lemma,
      note: content.note,
      part_of_speech: content.part_of_speech,
      position: 0,
      prerequisite: null,
      prompt_id: old?.sense.prompt.id ?? `${senseId}:it:v1`,
      sense_id: senseId,
      status: content.status,
      text: content.text,
    };
  });
  // Frequency starts the curriculum, while sibling derivatives are interleaved
  // by their own lemma frequency rather than shown as a semantic block.
  const byStepLemma = new Map(steps.map((s) => [s.lemma, s]));
  const ordered = [...steps];
  const insertedByLemma = new Map<string, number>();
  for (const [lemma, text, cue, note] of formLessons) {
    const parent = byStepLemma.get(lemma);
    if (!parent) {
      continue;
    }
    const form = resource.forms.find(
      (f) => f.lemma === lemma && f.text === text && f.part_of_speech === "VER"
    );
    if (!form) {
      throw new Error(`Missing source observation: ${lemma}/${text}`);
    }
    const senseId = `${form.id}:production-v1`;
    const sibling = insertedByLemma.get(lemma) ?? 0;
    insertedByLemma.set(lemma, sibling + 1);
    const position = Math.min(
      ordered.length,
      ordered.indexOf(parent) + 20 + sibling * 20
    );
    ordered.splice(position, 0, {
      cue: `${cue} — solo il verbo, senza pronome`,
      cue_source_id: source.id,
      description: `Present-tense form of ${lemma}; Italian cue: ${cue}.`,
      entry_id: parent.entry_id,
      family_id: parent.family_id,
      family_rank: parent.family_rank,
      form_id: form.id,
      id: stableId("curriculum-step", `${senseId}:it:v1`),
      lemma,
      note,
      part_of_speech: "VER",
      position: 0,
      prerequisite: parent.id,
      prompt_id: `${senseId}:it:v1`,
      sense_id: senseId,
      status: "machine_draft",
      text,
    });
  }
  const curriculum: Curriculum = {
    id: "fr-it-families-1000-curriculum-v1",
    language: "fr",
    policy:
      "frequency-led-v1: eligible lemma order; selected present forms follow their lemma with >=19 intervening targets; source ranks remain separate; one typed word/form per recall",
    prompt_language: "it",
    resource_id: resource.id,
    resource_sha256: contentHash(resource),
    schema_version: 1,
    sources: [legacy.cue_source, source],
    steps: ordered.map((s, i) => ({ ...s, position: i + 1 })),
    title: "French: 1,000 frequency-selected families with Italian cues",
  };
  validateCurriculum(resource, curriculum);
  return curriculum;
};

if (import.meta.main) {
  const archive = path.resolve(
    import.meta.dirname,
    "../../../../.cache/catalogue/Lexique400.zip"
  );
  const bytes = await readFile(archive);
  if (createHash("sha256").update(bytes).digest("hex") !== LEXIQUE_SHA256) {
    throw new Error("Source hash mismatch");
  }
  const tsv = execFileSync("unzip", ["-p", archive, "Lexique4/Lexique4.tsv"], {
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const resource = extractFamilyResource(tsv, 1000);
  const legacy = parseCatalogue(
    JSON.parse(
      await readFile(new URL("fr-it-1000.json", import.meta.url), "utf-8")
    )
  );
  const extra = v.parse(
    v.array(CurationRowSchema),
    JSON.parse(
      await readFile(
        new URL("curation-families.json", import.meta.url),
        "utf-8"
      )
    )
  );
  const curriculum = buildCurriculum(resource, legacy, extra);
  await writeFile(
    new URL("family-resource.json", import.meta.url),
    `${JSON.stringify(resource, null, 2)}\n`
  );
  await writeFile(
    new URL("curriculum-fr-it.json", import.meta.url),
    `${JSON.stringify(curriculum, null, 2)}\n`
  );
  console.log(
    JSON.stringify({
      families: resource.families.length,
      forms: resource.forms.length,
      learningTargets: curriculum.steps.length,
      lemmas: resource.lemmas.length,
    })
  );
}
