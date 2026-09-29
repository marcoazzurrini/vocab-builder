import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { readDeck, savePromptLanguage } from "../../src/repository";
import { testDatabase } from "../../src/testing";
import { compileCatalogue } from "./compile";
import type { Catalogue } from "./contract";
import { parseCatalogue } from "./contract";
import { extractCandidates } from "./extract";

const data = parseCatalogue(
  JSON.parse(
    await readFile(new URL("fr-it-1000.json", import.meta.url), "utf-8")
  )
);
const sample = () => ({
  ...structuredClone(data),
  entries: structuredClone(data.entries.slice(0, 3)),
});

describe("catalogue JSON contract", () => {
  it("contains 1000 unique ranked lemma targets with explicitly draft Italian cues", () => {
    expect(data.entries).toHaveLength(1000);
    expect(new Set(data.entries.map((e) => e.source_key)).size).toBe(1000);
    expect(
      data.entries.every((e) => e.sense.prompt.status === "machine_draft")
    ).toBe(true);
    expect(data.entries.every((e) => e.sense.prompt.language === "it")).toBe(
      true
    );
    expect(data.entries.some((e) => e.text === "se souvenir")).toBe(true);
  });
  it("rejects implicit publication, duplicate identities, invented totals and leaked answers", () => {
    expect(() => compileCatalogue(data)).toThrow("--allow-drafts");
    const duplicate = sample();
    const [first] = duplicate.entries;
    if (!first) {
      throw new Error("Missing fixture");
    }
    duplicate.entries.push(structuredClone(first));
    expect(() => parseCatalogue(duplicate)).toThrow("Duplicate ID");
    const invalid = sample();
    const [item] = invalid.entries;
    if (!item) {
      throw new Error("Missing fixture");
    }
    item.frequency_per_million += 2;
    expect(() => parseCatalogue(invalid)).toThrow(
      "Frequency aggregation mismatch"
    );
    item.frequency_per_million -= 2;
    item.sense.prompt.cue = item.text;
    expect(() => parseCatalogue(invalid)).toThrow("Cue reveals target");
  });
});

const row = (
  word: string,
  lemma: string,
  pos: string,
  frequency: number,
  isLemma = "1"
) =>
  [word, lemma, pos, String(frequency), isLemma, "", "", "", "", "", "1"].join(
    "\t"
  );

it("deduplicates repeated lemma totals, excludes function uses, and orders reproducibly", () => {
  const columns = [
    "1_Mot",
    "4_Lemme",
    "5_Cgram",
    "12_FreqLemme",
    "14_IsLem",
    "30_MorphoBase",
    "31_MorphoStruct",
    "32_MorphoDecomp",
    "3_Phono_IPA",
    "7_Genre",
    "10_FreqMot",
  ];
  const tsv = [
    columns.join("\t"),
    row("chats", "chat", "NOM", 10, "0"),
    row("chat", "chat", "NOM", 10),
    row("chat", "chat", "VER", 2),
    row("le", "le", "ART:def", 900),
    row("upas", "upas", "ADV", 18_000),
    row("chien", "chien", "NOM", 12),
  ].join("\n");
  const candidates = extractCandidates(tsv, 2);
  expect(candidates.map((e) => e.lemma)).toEqual(["chat", "chien"]);
  expect(candidates[0]?.frequency).toBe(12);
  expect(candidates[0]?.forms).toEqual(["chat", "chats"]);
});

describe("transactional D1 catalogue import", () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    database = await testDatabase();
    await database.binding.batch([
      database.binding.prepare(
        "INSERT INTO user(id,name,email,created_at,updated_at) VALUES ('catalogue-learner','Learner','catalogue@example.test',0,0)"
      ),
      database.binding.prepare(
        "INSERT INTO words(id,lang,text,gloss,gloss_lang,kind,freq_rank) VALUES ('retained-word','fr','ancien','vecchio','it','word',1)"
      ),
      database.binding.prepare(
        "INSERT INTO attempts(id,user_id,word_id,card_type,phase,typed,correct,rating,rep_number,latency_ms,reviewed_at,state_before,request) VALUES ('retained-attempt','catalogue-learner','retained-word','production','guess','',0,NULL,0,10,'2026-09-19T10:00:00.000Z','{}','{}')"
      ),
      database.binding.prepare(
        "INSERT INTO cards(user_id,word_id,card_type,revision,fsrs_state) VALUES ('catalogue-learner','retained-word','production',1,'{}')"
      ),
    ]);
  });
  afterAll(async () => {
    await database?.close();
  });
  const apply = (input: Catalogue, activate = true) => {
    const result = compileCatalogue(input, { activate, allowDrafts: true });
    return database.binding.batch(
      result.statements.map((s) =>
        database.binding.prepare(s.sql).bind(...s.params)
      )
    );
  };
  it("stages without exposing new drafts, then activates and preserves legacy progress", async () => {
    await apply(sample(), false);
    const staged = await readDeck(database.db, "catalogue-learner", "fr");
    expect(staged.words.map((w) => w.id)).toEqual(["retained-word"]);
    await apply(sample());
    await apply(sample());
    const snapshot = await readDeck(database.db, "catalogue-learner", "fr");
    expect(snapshot.words).toHaveLength(4);
    expect(
      snapshot.words
        .filter((word) => word.id !== "retained-word")
        .map((word) => word.freqRank)
    ).toEqual([1, 2, 3]);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.guesses).toHaveLength(1);
    expect(snapshot.cards[0]?.wordId).toBe("retained-word");
    expect(
      await database.binding
        .prepare("SELECT count(*) n FROM catalogue_senses")
        .first<number>("n")
    ).toBe(3);
    expect(
      await database.binding
        .prepare("SELECT count(*) n FROM attempts")
        .first<number>("n")
    ).toBe(1);
  });
  it("rejects rewriting published prompt content and rolls back the entire batch", async () => {
    const modified = sample();
    const [item] = modified.entries;
    if (!item) {
      throw new Error("Missing fixture");
    }
    item.sense.prompt.cue += " (changed)";
    const before = await database.binding
      .prepare("SELECT count(*) n FROM words")
      .first<number>("n");
    await expect(apply(modified)).rejects.toThrow();
    expect(
      await database.binding
        .prepare("SELECT count(*) n FROM words")
        .first<number>("n")
    ).toBe(before);
  });
  it("keeps prompt language configurable without changing target language or history", async () => {
    await savePromptLanguage(database.db, "catalogue-learner", "en");
    const snapshot = await readDeck(database.db, "catalogue-learner", "fr");
    expect(snapshot.words).toHaveLength(0);
    expect(
      await database.binding
        .prepare("SELECT count(*) n FROM cards")
        .first<number>("n")
    ).toBe(1);
    await savePromptLanguage(database.db, "catalogue-learner", "it");
  });
});
