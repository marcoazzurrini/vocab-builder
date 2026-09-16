import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createDatabase } from "../src/index";
import { testDatabase } from "../src/testing";
import { compileCatalogue } from "./import-catalogue";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
});
afterEach(async () => {
  await fixture?.close();
});
const word = {
  freq_rank: 1,
  gloss: "oggi",
  gloss_lang: "it",
  hint: null,
  id: "original-id",
  image: null,
  kind: "word",
  lang: "fr",
  text: "aujourd'hui",
};

describe("catalogue import", () => {
  it("runs the CLI only when executed directly by Bun", () => {
    const script = fileURLToPath(
      new URL("import-catalogue.ts", import.meta.url)
    );
    const imported = spawnSync(
      "bun",
      ["-e", `await import(${JSON.stringify(script)})`],
      {
        encoding: "utf-8",
        timeout: 5000,
      }
    );
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");

    const executed = spawnSync("bun", [script], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(executed.status).toBe(1);
    expect(executed.stderr).toContain(
      "Provide --config with the target Worker's Wrangler configuration."
    );
  });

  it("imports every row and repeats imports without duplicating words", async () => {
    const entries = [
      {
        ...word,
        created_at: "2020-01-02T03:04:05.000Z",
        freq_rank: null,
        gloss: "per favore",
        hint: "l'espressione; non SQL",
        id: "multi-chunk",
        image: "🙏",
        kind: "chunk",
        text: "s'il vous plaît",
      },
      {
        ...word,
        gloss: "estate'); DROP TABLE words; --",
        id: "multi-word",
        text: "été",
      },
    ] as const;
    const compiled = compileCatalogue(entries);
    expect(compiled.count).toBe(2);
    // D1 prepare().run() only executes one statement. Exercise the complete SQL file.
    await fixture.binding.exec(compiled.sql);
    const imported = await fixture.binding
      .prepare("SELECT * FROM words WHERE id LIKE 'multi-%' ORDER BY id")
      .all();
    expect(imported.results).toEqual([
      entries[0],
      { ...entries[1], created_at: expect.any(String) },
    ]);
    const defaultTimestamp = imported.results[1]?.created_at;
    expect(defaultTimestamp).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(String(defaultTimestamp)))).toBe(false);

    await fixture.binding.exec(compiled.sql);
    await fixture.binding.exec(compiled.sql);
    const repeated = await fixture.binding
      .prepare("SELECT * FROM words WHERE id LIKE 'multi-%' ORDER BY id")
      .all();
    expect(repeated.results).toEqual(imported.results);
  });

  it("applies explicit creation timestamps on insert and update", async () => {
    const entry = {
      ...word,
      created_at: "2019-02-03T04:05:06.000Z",
      gloss: "domani",
      id: "timestamp-word",
      text: "demain",
    };
    await fixture.binding.exec(compileCatalogue([entry]).sql);
    const read = () =>
      fixture.binding
        .prepare("SELECT id, created_at FROM words WHERE id = ?")
        .bind(entry.id)
        .first();
    expect(await read()).toEqual({
      created_at: entry.created_at,
      id: entry.id,
    });
    const changed = {
      ...entry,
      created_at: "2021-06-07T08:09:10.000Z",
      id: "replacement-timestamp-id",
    };
    await fixture.binding.exec(compileCatalogue([changed]).sql);
    expect(await read()).toEqual({
      created_at: changed.created_at,
      id: entry.id,
    });
  });

  it("escapes text and preserves existing IDs, cards, attempts, and creation timestamps", async () => {
    const createdAt = "2018-01-02T03:04:05.000Z";
    await fixture.binding.exec(
      compileCatalogue([{ ...word, created_at: createdAt }]).sql
    );
    const before = await fixture.binding
      .prepare("SELECT id, text, created_at FROM words WHERE id = ?")
      .bind(word.id)
      .first();
    await fixture.binding
      .prepare(
        "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u', 'Learner', 'u@example.com', 1, 1)"
      )
      .run();
    const learner = createDatabase(fixture.binding).forUser("u");
    await learner.recordAnswer({
      expectedReps: 0,
      id: "11111111-1111-4111-8111-111111111111",
      latencyMs: 1000,
      phase: "guess",
      rating: null,
      reviewedAt: "2026-09-10T09:00:00.000Z",
      typed: "",
      wordId: word.id,
    });
    await learner.recordAnswer({
      expectedReps: 0,
      id: "22222222-2222-4222-8222-222222222222",
      latencyMs: 2000,
      phase: "recall",
      rating: 3,
      reviewedAt: "2026-09-10T09:01:00.000Z",
      typed: word.text,
      wordId: word.id,
    });
    const readProgress = async () => {
      const attempts = await fixture.binding
        .prepare("SELECT * FROM attempts ORDER BY id")
        .all();
      const cards = await fixture.binding.prepare("SELECT * FROM cards").all();
      return { attempts: attempts.results, cards: cards.results };
    };
    const progress = await readProgress();
    expect(progress.cards).toHaveLength(1);
    expect(progress.cards[0]?.revision).toBe(1);
    expect(progress.attempts).toHaveLength(2);
    const updatedWord = {
      ...word,
      freq_rank: 42,
      gloss_lang: "en",
      hint: "today's word",
      id: "source-id",
      image: "🗓️",
      kind: "chunk",
    };
    const update = compileCatalogue([updatedWord]);
    await fixture.binding.exec(update.sql);
    await fixture.binding.exec(update.sql);
    const after = await fixture.binding
      .prepare("SELECT id, text, created_at FROM words WHERE id = ?")
      .bind(word.id)
      .first();
    expect(after).toEqual(before);
    expect(await readProgress()).toEqual(progress);
    expect(
      await fixture.binding
        .prepare("SELECT * FROM words WHERE id = ?")
        .bind(word.id)
        .first<typeof updatedWord & { created_at: string }>()
    ).toEqual({ ...updatedWord, created_at: createdAt, id: word.id });
    expect(
      await fixture.binding
        .prepare("SELECT id FROM words WHERE id = 'source-id'")
        .first()
    ).toBeNull();
  });

  it("validates every row before producing executable SQL", () => {
    for (const invalid of [
      [],
      [{ ...word, id: "" }],
      [{ ...word, kind: "other" }],
      [{ ...word, freq_rank: 1.5 }],
      [{ ...word, created_at: "never" }],
      [word, word],
      [word, { ...word, id: "duplicate-natural-key" }],
      [word, { ...word, text: "different" }],
      [
        word,
        { ...word, id: "invalid-later-row", kind: "other", text: "different" },
      ],
    ]) {
      expect(() => compileCatalogue(invalid)).toThrow();
    }
  });
});
