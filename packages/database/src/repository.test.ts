import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { createSession, DEFAULT_SETTINGS } from "@vocab/spaced-repetition";
import type { AnswerCommand } from "@vocab/spaced-repetition";
import { and, eq } from "drizzle-orm";

import { parseCatalogue } from "../scripts/import-catalogue";
import type { Database } from "./connection";
import { createDatabase, SaveConflict } from "./index";
import { attempts, cards, settings, user, words } from "./schema";
import { testDatabase } from "./testing";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let store: ReturnType<typeof createDatabase>;
const saveAnswer = (_db: Database, userId: string, answer: AnswerCommand) =>
  store.forUser(userId).recordAnswer(answer);
const readDeck = (_db: Database, userId: string, language: string) =>
  store.forUser(userId).snapshot(language);
const readSettings = (_db: Database, userId: string) =>
  store.forUser(userId).settings();
let serial = 0;
const now = new Date("2026-09-10T09:00:00.000Z");

beforeAll(async () => {
  fixture = await testDatabase();
  store = createDatabase(fixture.binding);
});
afterAll(async () => {
  await fixture?.close();
});

const learner = async () => {
  serial += 1;
  const id = `user-${serial}`;
  await fixture.db.insert(user).values({
    createdAt: now,
    email: `${id}@example.com`,
    id,
    name: "Learner",
    updatedAt: now,
  });
  const wordId = `word-${serial}`;
  await fixture.db
    .insert(words)
    .values({ gloss: `cane-${serial}`, id: wordId, lang: "fr", text: "chien" });
  const guess: AnswerCommand = {
    expectedReps: 0,
    id: crypto.randomUUID(),
    latencyMs: 1000,
    phase: "guess",
    rating: null,
    reviewedAt: now.toISOString(),
    typed: "",
    wordId,
  };
  const recall: AnswerCommand = {
    ...guess,
    id: crypto.randomUUID(),
    phase: "recall",
    rating: 3,
    reviewedAt: new Date(now.getTime() + 60_000).toISOString(),
    typed: "chien",
  };
  return { guess, id, recall, wordId };
};

const history = (userId: string) =>
  fixture.db.select().from(attempts).where(eq(attempts.user_id, userId));
const schedule = (userId: string) =>
  fixture.db.select().from(cards).where(eq(cards.user_id, userId));

describe("D1 persistence", () => {
  it("preserves the public SaveConflict error contract", () => {
    const error = new SaveConflict();
    expect(error).toBeInstanceOf(Error);
    expect(error.constructor.name).toBe("SaveConflict");
    expect(error.name).toBe("Error");
    expect(String(error)).toBe(
      "Error: Progress changed on another device. Reload before answering again."
    );
    expect(JSON.stringify(error)).toBe("{}");
  });

  it("restores awaiting guesses and atomically saves a first recall", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    const rows = await readDeck(fixture.db, l.id, "fr");
    const session = createSession({ clock: () => now, snapshot: rows });
    expect(session.view.phase).toBe("exposure");
    await saveAnswer(fixture.db, l.id, l.recall);
    expect(await history(l.id)).toHaveLength(2);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(1);
    expect(card?.fsrs_state).toEqual(expect.objectContaining({ reps: 1 }));
  });

  it("rolls back the attempt when the second statement fails", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await fixture.binding
      .prepare(
        `CREATE TRIGGER reject_card BEFORE INSERT ON cards WHEN NEW.user_id = '${l.id}' BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;`
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
      expectedReps: 1,
      id: crypto.randomUUID(),
      reviewedAt: new Date(now.getTime() + 120_000).toISOString(),
    };
    await saveAnswer(fixture.db, l.id, second);
    await saveAnswer(fixture.db, l.id, l.recall);
    expect(await history(l.id)).toHaveLength(3);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(2);
  });

  it("accepts racing retries of the same answer without duplicating history", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await Promise.all([
      saveAnswer(fixture.db, l.id, l.recall),
      saveAnswer(fixture.db, l.id, l.recall),
    ]);
    expect(await history(l.id)).toHaveLength(2);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(1);
  });

  it("accepts historical command property order without replaying progress", async () => {
    const l = await learner();
    const request = JSON.stringify(l.guess, [
      "id",
      "wordId",
      "phase",
      "typed",
      "rating",
      "latencyMs",
      "reviewedAt",
      "expectedReps",
    ]);
    expect(request).not.toBe(JSON.stringify(l.guess));
    // Insert the historical bytes directly because attempt history is append-only.
    await fixture.db.insert(attempts).values({
      card_type: "production",
      correct: false,
      id: l.guess.id,
      latency_ms: l.guess.latencyMs,
      phase: l.guess.phase,
      rating: l.guess.rating,
      rep_number: 0,
      request,
      reviewed_at: l.guess.reviewedAt,
      state_before: { reps: 0 },
      typed: l.guess.typed,
      user_id: l.id,
      word_id: l.wordId,
    });
    await saveAnswer(fixture.db, l.id, l.guess);
    await saveAnswer(fixture.db, l.id, l.recall);
    const before = await schedule(l.id);
    await saveAnswer(fixture.db, l.id, l.guess);
    expect(await schedule(l.id)).toEqual(before);
    const saved = await history(l.id);
    expect(saved).toHaveLength(2);
    expect(saved.find((row) => row.id === l.guess.id)?.request).toBe(request);
    await expect(
      saveAnswer(fixture.db, l.id, { ...l.guess, typed: "different" })
    ).rejects.toThrow("An answer ID cannot be reused for a different answer.");
    await expect(
      saveAnswer(fixture.db, l.id, {
        ...l.guess,
        latencyMs: l.guess.latencyMs + 1,
      })
    ).rejects.toThrow("An answer ID cannot be reused for a different answer.");
    expect(await history(l.id)).toHaveLength(2);
    expect(await schedule(l.id)).toEqual(before);
  });

  it("rejects reuse of an ID with a different payload", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await expect(
      saveAnswer(fixture.db, l.id, { ...l.guess, typed: "different" })
    ).rejects.toThrow(/ID/u);
  });

  it("allows only one of two racing recalls against the same revision", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    const results = await Promise.allSettled([
      saveAnswer(fixture.db, l.id, l.recall),
      saveAnswer(fixture.db, l.id, { ...l.recall, id: crypto.randomUUID() }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(await history(l.id)).toHaveLength(2);
    const [card] = await schedule(l.id);
    expect(card?.revision).toBe(1);
  });

  it("rejects a recall without its guess and leaves no schedule behind", async () => {
    const l = await learner();
    await expect(saveAnswer(fixture.db, l.id, l.recall)).rejects.toThrow();
    expect(await history(l.id)).toHaveLength(0);
    expect(await schedule(l.id)).toHaveLength(0);
  });

  it("rejects invalid ratings, unknown fields, and unknown words", async () => {
    const l = await learner();
    // The extra owner field must reach the strict runtime parser, not be stripped by a test helper.
    const forgedOwner = { ...l.guess, userId: "someone-else" };
    await expect(saveAnswer(fixture.db, l.id, forgedOwner)).rejects.toThrow();
    await expect(
      saveAnswer(fixture.db, l.id, { ...l.guess, wordId: "missing" })
    ).rejects.toThrow(/Word/u);
    await saveAnswer(fixture.db, l.id, l.guess);
    await expect(
      saveAnswer(fixture.db, l.id, { ...l.recall, rating: 3, typed: "wrong" })
    ).rejects.toThrow(/Rating/u);
    await expect(
      saveAnswer(fixture.db, l.id, { ...l.recall, rating: 4 })
    ).rejects.toThrow(/Easy/u);
    expect(await history(l.id)).toHaveLength(1);
  });

  it("scopes cards, guesses, and settings by user and language", async () => {
    const a = await learner();
    const b = await learner();
    await saveAnswer(fixture.db, a.id, a.guess);
    await saveAnswer(fixture.db, a.id, a.recall);
    await fixture.db
      .insert(words)
      .values({ gloss: "cane", id: "es-word", lang: "es", text: "perro" });
    await saveAnswer(fixture.db, a.id, {
      ...a.guess,
      id: crypto.randomUUID(),
      wordId: "es-word",
    });
    await fixture.db
      .insert(settings)
      .values({ lang: "es", new_per_day: 7, user_id: a.id });
    const aDeck = await readDeck(fixture.db, a.id, "fr");
    expect(aDeck.cards.map((card) => card.wordId)).toEqual([a.wordId]);
    expect(aDeck.guesses.map((guess) => guess.wordId)).toEqual([a.wordId]);
    const bDeck = await readDeck(fixture.db, b.id, "fr");
    expect(bDeck.cards).toEqual([]);
    expect(bDeck.guesses).toEqual([]);
    expect(await readSettings(fixture.db, b.id)).toEqual(DEFAULT_SETTINGS);
    const aSettings = await readSettings(fixture.db, a.id);
    expect(aSettings.newPerDay).toBe(7);
  });

  it("enforces append-only history and protects words with history", async () => {
    const l = await learner();
    await saveAnswer(fixture.db, l.id, l.guess);
    await expect(
      fixture.db
        .update(attempts)
        .set({ typed: "tampered" })
        .where(eq(attempts.user_id, l.id))
        .run()
    ).rejects.toThrow();
    await expect(
      fixture.db.delete(attempts).where(eq(attempts.user_id, l.id)).run()
    ).rejects.toThrow();
    await expect(
      fixture.db.delete(words).where(eq(words.id, l.wordId)).run()
    ).rejects.toThrow();
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
    const source = parseCatalogue(
      JSON.parse(
        await readFile(
          new URL("../scripts/words.json", import.meta.url),
          "utf-8"
        )
      )
    );
    expect(source).toHaveLength(50);
    expect(source.filter((word) => word.kind === "chunk")).toHaveLength(15);
    await fixture.binding
      .prepare(
        "CREATE TABLE legacy_words (lang TEXT, text TEXT, gloss TEXT, hint TEXT, image TEXT, kind TEXT, freq_rank INTEGER)"
      )
      .run();
    const legacySeed = await readFile(
      new URL("../tests/fixtures/legacy-catalogue/seed.sql", import.meta.url),
      "utf-8"
    );
    await fixture.binding
      .prepare(
        legacySeed
          .slice(legacySeed.indexOf("insert into public.words"))
          .replace("public.words", "legacy_words")
          .replace(
            "on conflict on constraint words_lang_text_gloss_unique do nothing",
            ""
          )
      )
      .run();
    const punctuation = await readFile(
      new URL(
        "../tests/fixtures/legacy-catalogue/punctuation.sql",
        import.meta.url
      ),
      "utf-8"
    );
    for (const statement of punctuation
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .replaceAll("public.words", "legacy_words")
      .split(";")
      .filter((part) => part.trim())) {
      // Punctuation corrections must run in their historical SQL order.
      // eslint-disable-next-line no-await-in-loop
      await fixture.binding.prepare(statement).run();
    }
    const original = await fixture.binding
      .prepare(
        "SELECT lang, text, gloss, hint, image, kind, freq_rank FROM legacy_words ORDER BY freq_rank"
      )
      .all<
        Pick<
          typeof words.$inferSelect,
          "lang" | "text" | "gloss" | "hint" | "image" | "kind" | "freq_rank"
        >
      >();
    expect(
      source.map(({ lang, text, gloss, hint, image, kind, freq_rank }) => ({
        freq_rank,
        gloss,
        hint,
        image,
        kind,
        lang,
        text,
      }))
    ).toEqual(original.results);
    // Keep each insert below D1's bound-parameter limit.
    await Promise.all(
      source.map((word) =>
        fixture.db.insert(words).values(word).onConflictDoNothing()
      )
    );
    const stored = await fixture.db
      .select()
      .from(words)
      .where(and(eq(words.lang, "fr"), eq(words.text, "comment ça va ?")));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.gloss).toBe("come va?");
  });
});
