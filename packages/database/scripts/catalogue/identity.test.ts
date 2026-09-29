import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";

import { testDatabase } from "../../src/testing";
import { compileCatalogue } from "./compile";
import type { Catalogue } from "./contract";
import { parseCatalogue } from "./contract";

const fixture = parseCatalogue(
  JSON.parse(
    await readFile(new URL("fr-it-1000.json", import.meta.url), "utf-8")
  )
);
const baseline = { ...fixture, entries: fixture.entries.slice(0, 2) };

describe("catalogue source and prompt identities", () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  const apply = (data: Catalogue) =>
    database.binding.batch(
      compileCatalogue(data, { allowDrafts: true }).statements.map(
        (statement) =>
          database.binding.prepare(statement.sql).bind(...statement.params)
      )
    );
  beforeEach(async () => {
    database = await testDatabase();
    await apply(baseline);
  });
  afterEach(async () => {
    await database?.close();
  });

  it("cannot silently reuse a prompt ID for a different meaning", async () => {
    const changed = structuredClone(baseline);
    const [entry] = changed.entries;
    if (!entry) {
      throw new Error("Missing test entry");
    }
    entry.sense.id += ":different-meaning";
    await expect(apply(changed)).rejects.toThrow(
      "Catalogue prompt version is immutable"
    );
    expect(
      await database.binding
        .prepare("SELECT count(*) n FROM catalogue_senses")
        .first<number>("n")
    ).toBe(2);
  });
  it("cannot silently change a named list's ranking policy", async () => {
    await expect(
      apply({ ...baseline, ranking_policy: "a different selection policy" })
    ).rejects.toThrow("Catalogue list version is immutable");
  });
  it("cannot rewrite frequency evidence under the same source version", async () => {
    const changed = structuredClone(baseline);
    const [entry] = changed.entries;
    const [observation] = entry?.frequencies ?? [];
    if (!entry || !observation) {
      throw new Error("Missing test entry");
    }
    entry.frequency_per_million += 1;
    observation.per_million += 1;
    await expect(apply(changed)).rejects.toThrow(
      "Catalogue source frequency is immutable"
    );
  });
});
