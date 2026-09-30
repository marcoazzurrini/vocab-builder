import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";

import * as v from "valibot";

import { compileCurriculum } from "./compile-curriculum";
import { parseCatalogue } from "./contract";
import { buildCurriculum } from "./curriculum";
import type { CurationRow, Curriculum } from "./curriculum";
import type { FamilyResource } from "./families";
import {
  membershipSchema,
  membershipSql,
  rehearseImport,
  renderStatements,
  stageAndActivate,
  verifyMembership,
} from "./remote";

const load = async (name: string) =>
  JSON.parse(await readFile(new URL(name, import.meta.url), "utf-8"));
// SAFETY: Checked-in fixtures are validated by compileCurriculum before any SQL is produced.
const resource = (await load("family-resource.json")) as FamilyResource;
// SAFETY: compileCurriculum validates curriculum identities, coverage, and the resource hash.
const curriculum = (await load("curriculum-fr-it.json")) as Curriculum;
// SAFETY: Checked-in editorial fixture consumed by buildCurriculum and compiler validation.
const extra = (await load("curation-families.json")) as CurationRow[];
const chosen = resource.families.slice(0, 4);
const names = new Set(chosen.flatMap((family) => family.lemmas));
const small = {
  ...resource,
  families: chosen,
  forms: resource.forms.filter((form) => names.has(form.lemma)),
  lemmas: resource.lemmas.filter((lemma) => names.has(lemma.lemma)),
};
const lessons = buildCurriculum(
  small,
  parseCatalogue(await load("fr-it-1000.json")),
  extra
);
const compiled = compileCurriculum(small, lessons, {
  allowDrafts: true,
  expectedFamilyCount: 4,
});
const sql = renderStatements(compiled.statements);
const migrations = new URL("../../migrations/", import.meta.url);
const migrationFiles = await readdir(migrations);
const migrationContents = await Promise.all(
  migrationFiles
    .filter((file) => file.endsWith(".sql"))
    .toSorted()
    .map((file) => readFile(new URL(file, migrations), "utf-8"))
);
const schema = migrationContents.join("\n");
const [first] = lessons.steps;
if (!first) {
  throw new Error("Missing curriculum fixture");
}
const backup =
  schema +
  renderStatements([
    {
      params: [],
      sql: "INSERT INTO user(id,name,email,created_at,updated_at) VALUES ('learner','Learner','remote@example.test',0,0)",
    },
    { params: [], sql: "INSERT INTO settings(user_id) VALUES ('learner')" },
    {
      params: [first.text, first.cue],
      sql: "INSERT INTO words(id,lang,text,gloss,hint) VALUES ('existing','fr',?,?,'historical hint')",
    },
    {
      params: [],
      sql: "INSERT INTO attempts(id,user_id,word_id,phase,typed,correct,latency_ms,state_before,reviewed_at,rep_number,request) VALUES ('guess','learner','existing','guess','',0,1,'{}','2026-09-20T10:00:00.000Z',0,'{}')",
    },
    {
      params: [],
      sql: "INSERT INTO teachings(id,user_id,word_id,completed_at,initial_recall_at,latency_ms,request) VALUES ('teaching','learner','existing','2026-09-20T10:00:00.000Z','2026-09-20T10:01:00.000Z',1,'{}')",
    },
    {
      params: [],
      sql: "INSERT INTO cards(user_id,word_id,revision,fsrs_state) VALUES ('learner','existing',1,'{}')",
    },
  ]);

const open = () => {
  const database = new Database(":memory:");
  database.exec(backup);
  database.exec("PRAGMA foreign_keys=ON");
  return database;
};

it("renders parameter literals once, preserving Unicode, quotes, question marks, null and numbers", () => {
  const database = new Database(":memory:");
  try {
    const text = "l'été ? $& '; DROP TABLE words; --\nsecond line";
    const rendered = renderStatements([
      {
        params: [text, null, 1.25],
        sql: "SELECT ? AS text, ? AS absent, ? AS frequency",
      },
    ]);
    expect(database.query(rendered).get()).toEqual({
      absent: null,
      frequency: 1.25,
      text,
    });
    expect(() => renderStatements([{ params: [], sql: "SELECT ?" }])).toThrow(
      "placeholder count"
    );
    expect(() => renderStatements([{ params: [1], sql: "SELECT 1" }])).toThrow(
      "placeholder count"
    );
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, "a\0b"]) {
      expect(() =>
        renderStatements([{ params: [value], sql: "SELECT ?" }])
      ).toThrow("Unsupported SQL parameter");
    }
  } finally {
    database.close();
  }
});

it("produces the same rows as parameterized compiler statements and preserves historical IDs", () => {
  const rendered = open();
  const parameterized = open();
  try {
    rendered.exec(sql);
    parameterized.transaction(() => {
      for (const statement of compiled.statements) {
        parameterized.query(statement.sql).run(...statement.params);
      }
    })();
    const tables = rendered
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();
    for (const { name } of tables) {
      const rows = (database: Database) =>
        database
          .query<Record<string, string | number | null>, []>(
            `SELECT * FROM ${name} ORDER BY rowid`
          )
          .all()
          .map((row) => {
            if (name !== "words") {
              return row;
            }
            // SQL-generated creation timestamps are intentionally not an identity input.
            const { created_at: _createdAt, ...rest } = row;
            return rest;
          });
      expect(rows(rendered)).toEqual(rows(parameterized));
    }
    expect(
      rendered
        .query("SELECT word_id FROM catalogue_prompts WHERE id=?")
        .get(first.prompt_id)
    ).toEqual({ word_id: "existing" });
    expect(rehearseImport(backup, sql, compiled)).toMatchObject({
      families: 4,
      targets: compiled.targets,
    });
    expect(rehearseImport(backup + sql, sql, compiled)).toEqual(
      rehearseImport(backup, sql, compiled)
    );
  } finally {
    rendered.close();
    parameterized.close();
  }
});

it("rehearses all 1000 families before production writes and rejects incomplete or destructive plans", () => {
  const full = compileCurriculum(resource, curriculum, { allowDrafts: true });
  expect(
    rehearseImport(backup, renderStatements(full.statements), full)
  ).toMatchObject({
    families: 1000,
    forms: 12_498,
    lemmas: 1049,
    members: 1084,
    presentations: 1084,
    selected_forms: 35,
    targets: 1084,
  });
  expect(() =>
    rehearseImport(backup, `${sql}UPDATE settings SET new_per_day=5;`, compiled)
  ).toThrow("learning-history data");
  expect(() =>
    rehearseImport(backup, `${sql}UPDATE words SET hint='changed';`, compiled)
  ).toThrow();
  expect(() =>
    rehearseImport(
      backup,
      renderStatements(compiled.statements.slice(0, -1)),
      compiled
    )
  ).toThrow("counts or hashes");
  const database = open();
  try {
    database.exec(sql);
    const value = verifyMembership(
      v.parse(membershipSchema, database.query(membershipSql(compiled)).get()),
      compiled
    );
    for (const key of [
      "families",
      "forms",
      "lemmas",
      "members",
      "presentations",
      "projections",
      "selected_forms",
      "targets",
      "taught_families",
    ]) {
      expect(() => verifyMembership({ ...value, [key]: -1 }, compiled)).toThrow(
        "counts or hashes"
      );
    }
    for (const key of ["content_hash", "resource_hash"]) {
      expect(() =>
        verifyMembership({ ...value, [key]: "wrong" }, compiled)
      ).toThrow("counts or hashes");
    }
  } finally {
    database.close();
  }
});

describe("two-phase remote import orchestration", () => {
  it("stages without activation, then activates and retries without losing concurrent learning", async () => {
    const database = open();
    const phases: string[] = [];
    const query = (statement: string) => database.query(statement).all();
    const execute = (statement: string, phase: string) => {
      database.transaction(() => database.exec(statement))();
      phases.push(phase);
      return Promise.resolve();
    };
    try {
      await stageAndActivate(compiled, false, query, execute);
      expect(phases).toEqual(["catalogue"]);
      expect(query("SELECT is_default FROM catalogue_lists")).toEqual([
        { is_default: 0 },
      ]);
      const result = await stageAndActivate(
        compiled,
        true,
        query,
        async (statement, phase) => {
          await execute(statement, phase);
          if (phase === "catalogue") {
            database.exec(
              "INSERT INTO cards(user_id,word_id,revision,fsrs_state) SELECT 'learner',id,1,'{}' FROM words WHERE id <> 'existing' LIMIT 1"
            );
          }
        }
      );
      expect(result.after.cards).toBe(result.before.cards + 1);
      expect(query("SELECT is_default FROM catalogue_lists")).toEqual([
        { is_default: 1 },
      ]);
      await stageAndActivate(compiled, true, query, execute);
      expect(query("SELECT count(*) AS count FROM cards")).toEqual([
        { count: 2 },
      ]);
      expect(query("SELECT count(*) AS count FROM teachings")).toEqual([
        { count: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it("never activates after a failed import or failed verification, and allows retry", async () => {
    const database = open();
    const phases: string[] = [];
    const query = (statement: string) => database.query(statement).all();
    const execute = (statement: string, phase: string) => {
      phases.push(phase);
      database.transaction(() => database.exec(statement))();
      return Promise.resolve();
    };
    try {
      await expect(
        stageAndActivate(compiled, true, query, () =>
          Promise.reject(new Error("interrupted import"))
        )
      ).rejects.toThrow("interrupted import");
      expect(query("SELECT * FROM catalogue_lists")).toEqual([]);
      await expect(
        stageAndActivate(
          compiled,
          true,
          (statement) =>
            statement === membershipSql(compiled) ? [{}] : query(statement),
          execute
        )
      ).rejects.toThrow();
      expect(phases).toEqual(["catalogue"]);
      expect(query("SELECT is_default FROM catalogue_lists")).toEqual([
        { is_default: 0 },
      ]);
      await expect(
        stageAndActivate(
          compiled,
          true,
          (statement) =>
            statement === "PRAGMA foreign_key_check"
              ? [{ violation: true }]
              : query(statement),
          execute
        )
      ).rejects.toThrow("foreign-key check failed");
      expect(phases).not.toContain("activate");
      await stageAndActivate(compiled, true, query, execute);
      expect(phases.at(-1)).toBe("activate");
      const activated = compileCurriculum(small, lessons, {
        activate: true,
        allowDrafts: true,
        expectedFamilyCount: 4,
      });
      await expect(
        stageAndActivate(activated, true, query, execute)
      ).rejects.toThrow("compile without activation");
    } finally {
      database.close();
    }
  });
});
