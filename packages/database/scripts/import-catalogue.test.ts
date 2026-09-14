import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../src/testing";
import { compileCatalogue } from "./import-catalogue";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  fixture = await testDatabase();
});
afterAll(async () => {
  await fixture?.close();
});
const word = {
  id: "original-id",
  lang: "fr",
  text: "aujourd'hui",
  gloss: "oggi",
  gloss_lang: "it",
  hint: null,
  image: null,
  kind: "word",
  freq_rank: 1,
};

describe("catalogue import", () => {
  it("runs the CLI only when executed directly by Bun", () => {
    const script = fileURLToPath(new URL("./import-catalogue.ts", import.meta.url));
    const imported = spawnSync("bun", ["-e", `await import(${JSON.stringify(script)})`], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(imported.status).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");

    const executed = spawnSync("bun", [script], { encoding: "utf8", timeout: 5_000 });
    expect(executed.status).toBe(1);
    expect(executed.stderr).toContain(
      "Provide --config with the target Worker's Wrangler configuration.",
    );
  });

  it("escapes text and preserves existing IDs, progress, and creation timestamps", async () => {
    await fixture.binding.prepare(compileCatalogue([word]).sql).run();
    const before = await fixture.binding.prepare("SELECT id, text, created_at FROM words").first();
    await fixture.binding
      .prepare(
        "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u', 'Learner', 'u@example.com', 1, 1)",
      )
      .run();
    await fixture.binding
      .prepare(
        "INSERT INTO attempts (id,user_id,word_id,phase,typed,correct,rating,latency_ms,state_before,reviewed_at,rep_number,request) VALUES ('a','u','original-id','guess','',0,NULL,1,'{\"reps\":0}','2026-09-10T09:00:00Z',0,'{}')",
      )
      .run();
    const update = compileCatalogue([
      { ...word, id: "source-id", hint: "today's word", image: "🗓️" },
    ]);
    await fixture.binding.prepare(update.sql).run();
    const after = await fixture.binding.prepare("SELECT id, text, created_at FROM words").first();
    expect(after).toEqual(before);
    expect(await fixture.binding.prepare("SELECT word_id FROM attempts").first()).toEqual({
      word_id: "original-id",
    });
    expect(await fixture.binding.prepare("SELECT hint FROM words").first()).toEqual({
      hint: "today's word",
    });
  });

  it("validates every row before producing executable SQL", () => {
    for (const invalid of [
      [],
      [{ ...word, id: "" }],
      [{ ...word, kind: "other" }],
      [{ ...word, freq_rank: 1.5 }],
      [{ ...word, created_at: "never" }],
      [word, word],
      [word, { ...word, text: "different" }],
    ]) {
      expect(() => compileCatalogue(invalid)).toThrow();
    }
  });
});
