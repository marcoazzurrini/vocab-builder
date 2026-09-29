import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import type { AnswerCommand } from "@vocab/spaced-repetition";

import { createDatabase } from "../../src/index";
import { readDeck } from "../../src/repository";
import { testDatabase } from "../../src/testing";
import { compileCatalogue } from "./compile";
import { compileCurriculum } from "./compile-curriculum";
import { parseCatalogue } from "./contract";
import { buildCurriculum, validateCurriculum } from "./curriculum";
import type { CurationRow, Curriculum } from "./curriculum";
import { selectFamilies, validateFamilyResource } from "./families";
import type { FamilyResource } from "./families";
import { contentHash } from "./hash";
import { presentationFor } from "./presentations";

const load = async (name: string) =>
  JSON.parse(await readFile(new URL(name, import.meta.url), "utf-8"));
// SAFETY: Checked-in generated fixture; validateFamilyResource checks it below and before compilation.
const resource = (await load("family-resource.json")) as FamilyResource;
// SAFETY: Checked-in generated fixture; validateCurriculum checks its identities, coverage, and source hash.
const curriculum = (await load("curriculum-fr-it.json")) as Curriculum;
const legacy = parseCatalogue(await load("fr-it-1000.json"));
// SAFETY: Checked-in editorial fixture; its fields are consumed by the reproducible build assertion below.
const extra = (await load("curation-families.json")) as CurationRow[];

it("selects exactly 1000 genuine family records from the full lemma pool, with measured form frequencies", () => {
  validateFamilyResource(resource);
  validateCurriculum(resource, curriculum);
  expect(resource.families).toHaveLength(1000);
  expect(resource.lemmas.length).toBeGreaterThan(1000);
  expect(resource.forms.length).toBeGreaterThan(10_000);
  expect(
    resource.families.find((f) => f.lemmas.includes("travailler"))?.lemmas
  ).toContain("travail");
  expect(
    resource.forms.find(
      (f) =>
        f.lemma === "être" && f.text === "suis" && f.part_of_speech === "VER"
    )?.per_million
  ).toBeGreaterThan(0);
  expect(new Set(curriculum.steps.map((s) => s.family_id)).size).toBe(1000);
  expect(curriculum.steps.filter((s) => s.form_id).length).toBe(35);
});

it("rebuilds the curriculum reproducibly and orders selected forms after their lemma", () => {
  expect(buildCurriculum(resource, legacy, extra)).toEqual(curriculum);
  for (const step of curriculum.steps.filter((s) => s.form_id)) {
    const parent = curriculum.steps.find((s) => s.id === step.prerequisite);
    expect(parent).toBeDefined();
    expect(step.position - (parent?.position ?? 0)).toBeGreaterThanOrEqual(20);
    expect(step.cue).toContain("senza pronome");
    expect(step.prompt_id).not.toBe(parent?.prompt_id);
  }
});

it("preserves review status and rejects answer leakage inside otherwise informative cues", () => {
  const reviewed = structuredClone(legacy);
  const [first] = reviewed.entries;
  if (!first) {
    throw new Error("Empty fixture");
  }
  first.sense.prompt.status = "reviewed";
  expect(
    buildCurriculum(resource, reviewed, extra).steps.find(
      (s) => s.lemma === first.source_key && !s.form_id
    )?.status
  ).toBe("reviewed");
  const leaking = structuredClone(curriculum);
  const va = leaking.steps.find((s) => s.text === "va");
  if (!va) {
    throw new Error("Missing va form");
  }
  va.cue = "va (lui/lei; verbo andare)";
  expect(() => validateCurriculum(resource, leaking)).toThrow("answer-leaking");
});

it("clarifies être without rewriting its historical cue or selected meaning", () => {
  const step = curriculum.steps.find((s) => s.text === "être" && !s.form_id);
  if (!step) {
    throw new Error("Missing être fixture");
  }
  const before = structuredClone(step);
  const presentation = presentationFor(step);
  expect(presentation.meaning).toBe("essere");
  expect(presentation.context).toContain("dove si trova");
  expect(presentation.grammar).toBe("verbo · infinito");
  expect(presentation.example).toEqual({
    text: "être à la maison",
    translation: "essere a casa",
  });
  expect(presentation.explanation).toContain("solo il verbo");
  expect(step).toEqual(before);
});

it("separates a form's meaning from its person and keeps its worked explanation out of the cue", () => {
  const step = curriculum.steps.find((s) => s.text === "suis" && s.form_id);
  if (!step) {
    throw new Error("Missing suis fixture");
  }
  expect(presentationFor(step)).toMatchObject({
    context: "io; verbo essere",
    explanation: step.note,
    grammar: "verbo · presente · senza pronome",
    meaning: "sono",
  });
  expect(presentationFor(step).example).toBeNull();
});

it("hashes equivalent objects identically without ignoring lesson order", () => {
  const { families, forms, ...rest } = resource;
  const reordered = { ...rest, families, forms };
  expect(Object.keys(reordered)).not.toEqual(Object.keys(resource));
  expect(contentHash(resource)).toBe(contentHash(reordered));
  expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
});

it("rejects mismatched resources, undeclared prerequisites, fabricated totals and automatic draft publication", () => {
  expect(() => compileCurriculum(resource, curriculum)).toThrow(
    "--allow-drafts"
  );
  const changed = structuredClone(curriculum);
  changed.resource_sha256 = "wrong";
  expect(() => validateCurriculum(resource, changed)).toThrow(
    "identity mismatch"
  );
  const missing = structuredClone(curriculum);
  const [first] = missing.steps;
  if (!first) {
    throw new Error("Empty fixture");
  }
  first.prerequisite = "missing";
  expect(() => validateCurriculum(resource, missing)).toThrow("prerequisite");
  const invalid = structuredClone(resource);
  const [family] = invalid.families;
  if (!family) {
    throw new Error("Empty fixture");
  }
  family.per_million += 1;
  expect(() => validateFamilyResource(invalid)).toThrow("frequency total");
  expect(() => selectFamilies(resource.lemmas, -1)).toThrow("invalid limit");
});

const sample = () => {
  const chosen = resource.families.slice(0, 4);
  const names = new Set(chosen.flatMap((f) => f.lemmas));
  const small: FamilyResource = {
    ...structuredClone(resource),
    families: structuredClone(chosen),
    forms: resource.forms.filter((f) => names.has(f.lemma)),
    lemmas: resource.lemmas.filter((c) => names.has(c.lemma)),
  };
  return { curriculum: buildCurriculum(small, legacy, extra), resource: small };
};

describe("family curriculum D1 compatibility", () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  const fixture = sample();
  beforeAll(async () => {
    database = await testDatabase();
    await database.binding
      .prepare(
        "INSERT INTO user(id,name,email,created_at,updated_at) VALUES ('family-learner','Learner','families@example.test',0,0)"
      )
      .run();
    const old = {
      ...structuredClone(legacy),
      entries: legacy.entries.filter((e) =>
        fixture.resource.lemmas.some((c) => c.lemma === e.source_key)
      ),
    };
    const plan = compileCatalogue(old, { activate: true, allowDrafts: true });
    await database.binding.batch(
      plan.statements.map((s) =>
        database.binding.prepare(s.sql).bind(...s.params)
      )
    );
  });
  afterAll(async () => {
    await database?.close();
  });
  const apply = (active: boolean) => {
    const plan = compileCurriculum(fixture.resource, fixture.curriculum, {
      activate: active,
      allowDrafts: true,
      expectedFamilyCount: 4,
    });
    return database.binding.batch(
      plan.statements.map((s) =>
        database.binding.prepare(s.sql).bind(...s.params)
      )
    );
  };
  it("requires exactly 1000 families for production imports", () => {
    expect(() =>
      compileCurriculum(fixture.resource, fixture.curriculum, {
        allowDrafts: true,
      })
    ).toThrow("Expected 1000 families");
  });
  it("keeps dictionary presentation versions immutable, including REPLACE and deletion", async () => {
    await apply(false);
    const promptId = fixture.curriculum.steps[0]?.prompt_id;
    if (!promptId) {
      throw new Error("Missing presentation fixture");
    }
    await expect(
      database.binding
        .prepare(
          "UPDATE catalogue_presentations SET content='{}' WHERE prompt_id=?"
        )
        .bind(promptId)
        .run()
    ).rejects.toThrow("catalogue_presentation_immutable");
    await expect(
      database.binding
        .prepare("DELETE FROM catalogue_presentations WHERE prompt_id=?")
        .bind(promptId)
        .run()
    ).rejects.toThrow("catalogue_presentation_immutable");
    await expect(
      database.binding
        .prepare(
          "INSERT OR REPLACE INTO catalogue_presentations (prompt_id,version,source_id,content) SELECT prompt_id,version,source_id,'{}' FROM catalogue_presentations WHERE prompt_id=?"
        )
        .bind(promptId)
        .run()
    ).rejects.toThrow("catalogue_presentation_immutable");
    await apply(false);
  });
  it("stages, activates, reimports, and keeps pre-existing prompt IDs and schedules", async () => {
    const before = await readDeck(database.db, "family-learner", "fr");
    const [oldWord] = before.words;
    if (!oldWord) {
      throw new Error("Missing existing target");
    }
    await database.binding
      .prepare(
        "INSERT INTO cards(user_id,word_id,card_type,revision,fsrs_state) VALUES ('family-learner',?,'production',1,'{}')"
      )
      .bind(oldWord.id)
      .run();
    await apply(false);
    const staged = await readDeck(database.db, "family-learner", "fr");
    expect(staged.words.map((w) => w.id)).toEqual(
      before.words.map((w) => w.id)
    );
    await apply(true);
    await apply(true);
    const after = await readDeck(database.db, "family-learner", "fr");
    expect(after.words.length).toBe(fixture.curriculum.steps.length);
    expect(after.words.find((w) => w.text === "être")).toMatchObject({
      gloss: "essere in un luogo (infinito)",
      presentation: {
        example: { text: "être à la maison", translation: "essere a casa" },
        meaning: "essere",
      },
    });
    for (const w of before.words) {
      expect(after.words.some((n) => n.id === w.id)).toBe(true);
    }
    expect(after.cards).toEqual([{ schedule: "{}", wordId: oldWord.id }]);
    const form = after.words.find((w) => w.text === "suis");
    expect(form?.hint).toBeNull();
    expect(form?.revealNote).toContain("je suis");
    expect(form?.id).not.toBe(after.words.find((w) => w.text === "être")?.id);
    const violations = await database.binding
      .prepare("PRAGMA foreign_key_check")
      .all();
    expect(violations.results).toHaveLength(0);
  });
  it("persists a form's recall through the real repository without grading its lemma or family", async () => {
    await database.binding
      .prepare(
        "INSERT INTO user(id,name,email,created_at,updated_at) VALUES ('form-learner','Learner','form@example.test',0,0)"
      )
      .run();
    const store = createDatabase(database.binding).forUser("form-learner");
    const snapshot = await store.snapshot("fr");
    const form = snapshot.words.find((w) => w.text === "suis");
    const lemma = snapshot.words.find((w) => w.text === "être");
    if (!form || !lemma) {
      throw new Error("Missing inflection fixture");
    }
    const guess: AnswerCommand = {
      expectedReps: 0,
      id: crypto.randomUUID(),
      latencyMs: 1000,
      phase: "guess",
      rating: null,
      reviewedAt: "2026-09-20T10:00:00.000Z",
      typed: "",
      wordId: form.id,
    };
    await store.recordAnswer(guess);
    await store.recordAnswer({
      ...guess,
      id: crypto.randomUUID(),
      phase: "recall",
      rating: 3,
      reviewedAt: "2026-09-20T10:01:00.000Z",
      typed: "suis",
    });
    const restored = await createDatabase(database.binding)
      .forUser("form-learner")
      .snapshot("fr");
    expect(restored.guesses.map((g) => g.wordId)).toEqual([form.id]);
    expect(restored.cards.map((c) => c.wordId)).toEqual([form.id]);
    expect(restored.cards.some((c) => c.wordId === lemma.id)).toBe(false);
    const stored = await database.binding
      .prepare(
        "SELECT correct,phase FROM attempts WHERE user_id='form-learner' ORDER BY reviewed_at"
      )
      .all();
    expect(stored.results).toEqual([
      { correct: 0, phase: "guess" },
      { correct: 1, phase: "recall" },
    ]);
    const state = await database.binding
      .prepare(
        "SELECT revision,json_valid(fsrs_state) AS valid FROM cards WHERE user_id='form-learner'"
      )
      .first();
    expect(state).toEqual({ revision: 1, valid: 1 });
  });
  it("does not allow changing a published curriculum under the same ID", async () => {
    await expect(
      database.binding
        .prepare("UPDATE catalogue_curricula SET content_hash='changed'")
        .run()
    ).rejects.toThrow("immutable");
    await expect(
      database.binding
        .prepare("UPDATE catalogue_forms SET per_million=per_million+1")
        .run()
    ).rejects.toThrow("immutable");
  });
});
