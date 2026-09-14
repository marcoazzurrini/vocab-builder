import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { saveAnswer, readDeck, readSettings } from "./repository";
import { testDatabase } from "./testing";
import { attempts, cards, settings, user, words } from "./schema";
import { buildDeck, DEFAULT_SETTINGS, reviveFsrsCard } from "@vocab/study/deck";
import type { AnswerCommand } from "@vocab/study/commands";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let serial = 0;
const now = new Date("2026-09-10T09:00:00.000Z");

beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture?.close();
});

async function learner() {
  const id = `user-${++serial}`;
  await fixture.db
    .insert(user)
    .values({ id, name: "Learner", email: `${id}@example.com`, createdAt: now, updatedAt: now });
  const wordId = `word-${serial}`;
  await fixture.db
    .insert(words)
    .values({ id: wordId, lang: "fr", text: "chien", gloss: `cane-${serial}` });
  const guess: AnswerCommand = {
    id: crypto.randomUUID(),
    wordId,
    phase: "guess",
    typed: "",
    rating: null,
    latencyMs: 1000,
    reviewedAt: now.toISOString(),
    expectedReps: 0,
  };
  const recall: AnswerCommand = {
    ...guess,
    id: crypto.randomUUID(),
    phase: "recall",
    typed: "chien",
    rating: 3,
    reviewedAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  return { id, wordId, guess, recall };
}

async function history(userId: string) {
  return fixture.db.select().from(attempts).where(eq(attempts.user_id, userId));
}
async function schedule(userId: string) {
  return fixture.db.select().from(cards).where(eq(cards.user_id, userId));
}

describe("D1 persistence", () => {
  it("restores awaiting guesses and atomically saves a first recall", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    const rows = await readDeck(fixture.db, l.id, "fr");
    const deck = buildDeck(rows.words, rows.cards, rows.guesses, now);
    expect(deck.cards.find((card) => card.wordId === l.wordId)?.fsrs.reps).toBe(0);
    await saveAnswer(fixture.db, l.id, l.recall);
    expect(await history(l.id)).toHaveLength(2);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(1);
    expect(reviveFsrsCard(card?.fsrs_state).reps).toBe(1);
  });

  it("rolls back the attempt when the second statement fails", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await fixture.binding
      .prepare(
        `CREATE TRIGGER reject_card BEFORE INSERT ON cards WHEN NEW.user_id = '${l.id}' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;`,
      )
      .run();
    try {
      await expect(saveAnswer(fixture.db, l.id, l.recall)).rejects.toThrow();
      expect(await history(l.id)).toHaveLength(1);
      expect(await schedule(l.id)).toHaveLength(0);
    } finally {
      await fixture.binding.prepare("DROP TRIGGER reject_card").run();
    }
  });

  it("makes retries idempotent, even after later recalls", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await saveAnswer(fixture.db, l.id, l.guess);
    await saveAnswer(fixture.db, l.id, l.recall);
    const second = {
      ...l.recall,
      id: crypto.randomUUID(),
      expectedReps: 1,
      reviewedAt: new Date(now.getTime() + 120_000).toISOString(),
    };
    await saveAnswer(fixture.db, l.id, second);
    await saveAnswer(fixture.db, l.id, l.recall);
    expect(await history(l.id)).toHaveLength(3);
    expect((await schedule(l.id))[0]?.revision).toBe(2);
  });

  it("accepts racing retries of the same answer without duplicating history", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await Promise.all([
      saveAnswer(fixture.db, l.id, l.recall),
      saveAnswer(fixture.db, l.id, l.recall),
    ]);
    expect(await history(l.id)).toHaveLength(2);
    expect((await schedule(l.id))[0]?.revision).toBe(1);
  });

  it("rejects reuse of an ID with a different payload", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await expect(saveAnswer(fixture.db, l.id, { ...l.guess, typed: "different" })).rejects.toThrow(
      /ID/,
    );
  });

  it("allows only one of two racing recalls against the same revision", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    const results = await Promise.allSettled([
      saveAnswer(fixture.db, l.id, l.recall),
      saveAnswer(fixture.db, l.id, { ...l.recall, id: crypto.randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await history(l.id)).toHaveLength(2);
    expect((await schedule(l.id))[0]?.revision).toBe(1);
  });

  it("rejects a recall without its guess and leaves no schedule behind", async () => {
    const l = await learner();
    await expect(saveAnswer(fixture.db, l.id, l.recall)).rejects.toThrow();
    expect(await history(l.id)).toHaveLength(0);
    expect(await schedule(l.id)).toHaveLength(0);
  });

  it("rejects invalid ratings, unknown fields, and unknown words", async () => {
    const l = await learner();
    await expect(
      saveAnswer(fixture.db, l.id, { ...l.guess, userId: "someone-else" }),
    ).rejects.toThrow();
    await expect(saveAnswer(fixture.db, l.id, { ...l.guess, wordId: "missing" })).rejects.toThrow(
      /Word/,
    );
    await saveAnswer(fixture.db, l.id, l.guess);
    await expect(
      saveAnswer(fixture.db, l.id, { ...l.recall, typed: "wrong", rating: 3 }),
    ).rejects.toThrow(/Rating/);
    await expect(saveAnswer(fixture.db, l.id, { ...l.recall, rating: 4 })).rejects.toThrow(/Easy/);
    expect(await history(l.id)).toHaveLength(1);
  });

  it("scopes cards, guesses, and settings by user and language", async () => {
    const a = await learner();
    const b = await learner();
    await saveAnswer(fixture.db, a.id, a.guess);
    await saveAnswer(fixture.db, a.id, a.recall);
    await fixture.db
      .insert(words)
      .values({ id: "es-word", lang: "es", text: "perro", gloss: "cane" });
    await saveAnswer(fixture.db, a.id, { ...a.guess, id: crypto.randomUUID(), wordId: "es-word" });
    await fixture.db.insert(settings).values({ user_id: a.id, lang: "es", new_per_day: 7 });
    const aDeck = await readDeck(fixture.db, a.id, "fr");
    expect(aDeck.cards.map((card) => card.word_id)).toEqual([a.wordId]);
    expect(aDeck.guesses.map((guess) => guess.word_id)).toEqual([a.wordId]);
    expect((await readDeck(fixture.db, b.id, "fr")).cards).toEqual([]);
    expect((await readDeck(fixture.db, b.id, "fr")).guesses).toEqual([]);
    expect(await readSettings(fixture.db, b.id)).toEqual(DEFAULT_SETTINGS);
    expect((await readSettings(fixture.db, a.id)).newPerDay).toBe(7);
  });

  it("enforces append-only history and protects words with history", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await expect(
      fixture.db.update(attempts).set({ typed: "tampered" }).where(eq(attempts.user_id, l.id)),
    ).rejects.toThrow();
    await expect(fixture.db.delete(attempts).where(eq(attempts.user_id, l.id))).rejects.toThrow();
    await expect(fixture.db.delete(words).where(eq(words.id, l.wordId))).rejects.toThrow();
    expect(await history(l.id)).toHaveLength(1);
  });

  it("does not let one user claim another user's idempotency key", async () => {
    const a = await learner();
    const b = await learner();
    await saveAnswer(fixture.db, a.id, a.guess);
    await expect(saveAnswer(fixture.db, b.id, a.guess)).rejects.toThrow();
    expect(await history(b.id)).toHaveLength(0);
  });

  it("preserves the complete checked-in catalogue including corrected punctuation", async () => {
    const source = JSON.parse(
      await readFile(new URL("../../../data/words.json", import.meta.url), "utf8"),
    ) as (typeof words.$inferInsert)[];
    expect(source).toHaveLength(50);
    expect(source.filter((word) => word.kind === "chunk")).toHaveLength(15);
    await fixture.binding
      .prepare(
        "CREATE TABLE legacy_words (lang TEXT, text TEXT, gloss TEXT, hint TEXT, image TEXT, kind TEXT, freq_rank INTEGER)",
      )
      .run();
    const legacySeed = await readFile(
      new URL("../../../tests/fixtures/legacy-catalogue/seed.sql", import.meta.url),
      "utf8",
    );
    await fixture.binding
      .prepare(
        legacySeed
          .slice(legacySeed.indexOf("insert into public.words"))
          .replace("public.words", "legacy_words")
          .replace("on conflict on constraint words_lang_text_gloss_unique do nothing", ""),
      )
      .run();
    const punctuation = await readFile(
      new URL("../../../tests/fixtures/legacy-catalogue/punctuation.sql", import.meta.url),
      "utf8",
    );
    for (const statement of punctuation
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .replaceAll("public.words", "legacy_words")
      .split(";")
      .filter((part) => part.trim()))
      await fixture.binding.prepare(statement).run();
    const original = await fixture.binding
      .prepare(
        "SELECT lang, text, gloss, hint, image, kind, freq_rank FROM legacy_words ORDER BY freq_rank",
      )
      .all();
    expect(
      source.map(({ lang, text, gloss, hint, image, kind, freq_rank }) => ({
        lang,
        text,
        gloss,
        hint,
        image,
        kind,
        freq_rank,
      })),
    ).toEqual(original.results);
    for (const word of source) await fixture.db.insert(words).values(word).onConflictDoNothing();
    const stored = await fixture.db
      .select()
      .from(words)
      .where(and(eq(words.lang, "fr"), eq(words.text, "comment ça va ?")));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.gloss).toBe("come va?");
  });
});
