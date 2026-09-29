import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { stableId } from "./build";
import { extractCandidates, LEXIQUE_SHA256, LEXIQUE_URL } from "./extract";
import type { Candidate } from "./extract";

// Explicit derivational links, never inferred from spelling or a stemmer. Unlinked
// lemmas still form families with their inflections. This policy is deliberately
// conservative, not a claim to an exhaustive linguistic family classification.
export const derivations = [
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
  ["sûr", "sûrement"],
  ["fin", "finir"],
  ["perte", "perdre"],
  ["vente", "vendre"],
  ["voir", "vu"],
  ["entendre", "entendu"],
  ["prendre", "pris"],
  ["faire", "fait"],
  ["dire", "dit"],
  ["ouvrir", "ouvert"],
  ["fermer", "fermé"],
  ["vivre", "vivant"],
  ["fatiguer", "fatigué"],
  ["intéresser", "intéressé"],
  ["blesser", "blessé", "blessure"],
];
export const FAMILY_POLICY = "fr-inflection-and-explicit-derivation-v1";
export interface FormObservation {
  id: string;
  lemma: string;
  text: string;
  part_of_speech: string;
  per_million: number;
  gender: string | null;
  number: string | null;
  verb_info: string | null;
}
export interface Family {
  id: string;
  label: string;
  lemmas: string[];
  rank: number;
  per_million: number;
}
export interface FamilyResource {
  schema_version: 1;
  id: string;
  policy: string;
  source: { id: string; sha256: string; url: string };
  families: Family[];
  lemmas: Candidate[];
  forms: FormObservation[];
}
const round = (n: number) => Number(n.toFixed(3));

const validateFamilyMembers = (
  family: Family,
  lemmas: Map<string, Candidate>,
  members: Set<string>
) => {
  let total = 0;
  for (const lemma of family.lemmas) {
    const candidate = lemmas.get(lemma);
    if (
      !candidate ||
      members.has(lemma) ||
      !Number.isFinite(candidate.frequency) ||
      candidate.frequency < 0 ||
      candidate.frequencies.some(
        (f) => !Number.isFinite(f.perMillion) || f.perMillion < 0
      ) ||
      Math.abs(
        candidate.frequency -
          candidate.frequencies.reduce((n, f) => n + f.perMillion, 0)
      ) > 0.001
    ) {
      throw new Error("Invalid family member or lemma frequency");
    }
    total += candidate.frequency;
    members.add(lemma);
  }
  if (Math.abs(round(total) - family.per_million) > 0.001) {
    throw new Error("Invalid family frequency total");
  }
};

const validateFormObservations = (
  forms: FormObservation[],
  members: Set<string>
) => {
  const formIds = new Set<string>();
  for (const form of forms) {
    if (
      !members.has(form.lemma) ||
      !form.text.trim() ||
      formIds.has(form.id) ||
      form.id !==
        stableId(
          "fr-form",
          JSON.stringify([form.lemma, form.text, form.part_of_speech])
        ) ||
      !Number.isFinite(form.per_million) ||
      form.per_million < 0
    ) {
      throw new Error("Invalid form observation");
    }
    formIds.add(form.id);
  }
};

export const validateFamilyResource = (resource: FamilyResource) => {
  if (
    resource.schema_version !== 1 ||
    resource.policy !== FAMILY_POLICY ||
    resource.source.sha256 !== LEXIQUE_SHA256 ||
    !resource.families.length
  ) {
    throw new Error("Invalid family resource source or policy");
  }
  const lemmas = new Map(resource.lemmas.map((c) => [c.lemma, c]));
  if (lemmas.size !== resource.lemmas.length) {
    throw new Error("Duplicate lemma");
  }
  const members = new Set<string>();
  const familyIds = new Set<string>();
  let previousFrequency = Infinity;
  for (const [index, family] of resource.families.entries()) {
    if (
      family.id !== stableId("fr-family-v1", family.label) ||
      familyIds.has(family.id) ||
      family.rank !== index + 1 ||
      !family.lemmas.length ||
      !Number.isFinite(family.per_million) ||
      family.per_million < 0 ||
      family.per_million > previousFrequency
    ) {
      throw new Error("Invalid family identity or frequency rank");
    }
    validateFamilyMembers(family, lemmas, members);
    previousFrequency = family.per_million;
    familyIds.add(family.id);
  }
  if (members.size !== lemmas.size) {
    throw new Error("Unassigned lemma");
  }
  validateFormObservations(resource.forms, members);
};

export const selectFamilies = (
  candidates: Candidate[],
  limit: number
): Family[] => {
  const names = new Map<string, string>();
  for (const group of derivations) {
    const [label] = group;
    if (!label) {
      throw new Error("Empty family group");
    }
    for (const lemma of group) {
      if (names.has(lemma)) {
        throw new Error(`Duplicate family member: ${lemma}`);
      }
      names.set(lemma, label);
    }
  }
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const label = names.get(candidate.lemma) ?? candidate.lemma;
    const members = groups.get(label) ?? [];
    members.push(candidate);
    groups.set(label, members);
  }
  const families = [...groups]
    .map(([label, members]) => ({
      id: stableId("fr-family-v1", label),
      label,
      lemmas: members.map((m) => m.lemma).toSorted(),
      per_million: round(members.reduce((n, m) => n + m.frequency, 0)),
      rank: 0,
    }))
    .toSorted(
      (a, b) => b.per_million - a.per_million || (a.label < b.label ? -1 : 1)
    );
  if (!Number.isSafeInteger(limit) || limit < 1 || families.length < limit) {
    throw new Error("Not enough eligible families or invalid limit.");
  }
  return families
    .slice(0, limit)
    .map((f, index) => ({ ...f, rank: index + 1 }));
};

export const extractForms = (
  tsv: string,
  lemmas: Set<string>
): FormObservation[] => {
  const lines = tsv
    .replace(/^\uFEFF/u, "")
    .trimEnd()
    .split(/\r?\n/u);
  const headers = lines.shift()?.split("\t") ?? [];
  const column = (name: string) => {
    const i = headers.indexOf(name);
    if (i === -1) {
      throw new Error(`Missing Lexique column: ${name}`);
    }
    return i;
  };
  const positions = [
    "4_Lemme",
    "1_Mot",
    "5_Cgram",
    "10_FreqMot",
    "7_Genre",
    "8_Nombre",
    "9_InfoVER",
  ].map(column);
  const forms = new Map<string, FormObservation>();
  for (const line of lines) {
    const cells = line.split("\t");
    const [lemma, text, pos, frequency, gender, number, verbInfo] =
      positions.map((i) => cells[i] ?? "");
    if (!lemma || !text || !pos || !lemmas.has(lemma)) {
      continue;
    }
    const value = Number(frequency);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid form frequency: ${text}`);
    }
    const id = stableId("fr-form", JSON.stringify([lemma, text, pos]));
    const observation = {
      gender: gender || null,
      id,
      lemma,
      number: number || null,
      part_of_speech: pos,
      per_million: value,
      text,
      verb_info: verbInfo || null,
    };
    const previous = forms.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(observation)) {
      throw new Error(`Conflicting form observation: ${lemma}/${text}/${pos}`);
    }
    forms.set(id, observation);
  }
  return [...forms.values()].toSorted((a, b) => a.id.localeCompare(b.id, "en"));
};

export const extractFamilyResource = (
  tsv: string,
  count: number
): FamilyResource => {
  // The complete candidate pool is required: derivatives outside the old top 1000
  // can change a family's rank. Do not select 1000 lemmas and rename them families.
  const candidates = extractCandidates(tsv);
  const families = selectFamilies(candidates, count);
  const selected = new Set(families.flatMap((f) => f.lemmas));
  return {
    families,
    forms: extractForms(tsv, selected),
    id: "fr-lexique4-families-1000-v1",
    lemmas: candidates.filter((c) => selected.has(c.lemma)),
    policy: FAMILY_POLICY,
    schema_version: 1,
    source: { id: "lexique-4.00", sha256: LEXIQUE_SHA256, url: LEXIQUE_URL },
  };
};

if (import.meta.main) {
  const archive = path.resolve(
    import.meta.dirname,
    "../../../../.cache/catalogue/Lexique400.zip"
  );
  const bytes = await readFile(archive);
  if (createHash("sha256").update(bytes).digest("hex") !== LEXIQUE_SHA256) {
    throw new Error(
      "Lexique archive hash mismatch; run catalogue:extract first."
    );
  }
  const tsv = execFileSync("unzip", ["-p", archive, "Lexique4/Lexique4.tsv"], {
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const resource = extractFamilyResource(tsv, 1000);
  await writeFile(
    new URL("family-resource.json", import.meta.url),
    `${JSON.stringify(resource, null, 2)}\n`
  );
  console.log(
    JSON.stringify({
      families: resource.families.length,
      forms: resource.forms.length,
      lemmas: resource.lemmas.length,
    })
  );
}
