import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { D1Database } from "@cloudflare/workers-types";
import * as v from "valibot";
import { getPlatformProxy } from "wrangler";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url)
);
const migrationFiles = async () => {
  const files = await readdir(migrationsDirectory);
  return files.filter((file) => file.endsWith(".sql")).toSorted();
};

const temporaryConfig = async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "vocab-migrations-test-")
  );
  const configPath = path.join(directory, "wrangler.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compatibility_date: "2026-09-11",
        d1_databases: [
          {
            binding: "DB",
            database_id: "00000000-0000-0000-0000-000000000000",
            database_name: "migration-test",
            migrations_dir: migrationsDirectory,
          },
        ],
        name: "vocab-migrations-test",
      })
    );
    return { configPath, directory };
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
};

const applyMigration = async (binding: D1Database, file: string) => {
  const source = await readFile(path.join(migrationsDirectory, file), "utf-8");
  for (const statement of source
    .split("--> statement-breakpoint")
    .filter((part) => part.trim())) {
    // Schema changes must run in migration order, including complete trigger bodies.
    // eslint-disable-next-line no-await-in-loop
    await binding.prepare(statement).run();
  }
};

const legacyTables = [
  "user",
  "account",
  "session",
  "verification",
  "settings",
  "words",
  "cards",
  "attempts",
] as const;
const snapshot = (binding: D1Database) =>
  Promise.all(
    legacyTables.map(async (table) => {
      const result = await binding
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all();
      return { rows: result.results, table };
    })
  );

const guess = {
  card_type: "production",
  correct: 0,
  id: "invalid-attempt",
  latency_ms: 1000,
  phase: "guess",
  rating: null,
  rep_number: 0,
  request: "{}",
  reviewed_at: "2026-09-10T09:00:00.000Z",
  state_before: '{"reps":0}',
  typed: "",
  user_id: "learner",
  word_id: "unseen",
};
const recall = {
  ...guess,
  correct: 1,
  phase: "recall",
  rating: 3,
  rep_number: 2,
  word_id: "known",
};
const card = {
  card_type: "production",
  fsrs_state: '{"reps":1}',
  revision: 1,
  user_id: "learner",
  word_id: "unseen",
};

// Raw SQL bypasses application validation so these assertions exercise D1 constraints.
const rejectedRows = [
  {
    error: "words_kind",
    name: "word kind",
    row: {
      gloss: "gatto",
      id: "invalid",
      kind: "sentence",
      lang: "fr",
      text: "chat",
    },
    table: "words",
  },
  {
    error: "UNIQUE constraint failed",
    name: "catalogue identity",
    row: { gloss: "cane", id: "invalid", lang: "fr", text: "chien" },
    table: "words",
  },
  {
    error: "cards_production",
    name: "card type",
    row: { ...card, card_type: "recognition" },
    table: "cards",
  },
  {
    error: "cards_revision",
    name: "zero card revision",
    row: { ...card, revision: 0 },
    table: "cards",
  },
  {
    error: "cards_revision",
    name: "negative card revision",
    row: { ...card, revision: -1 },
    table: "cards",
  },
  {
    error: "cards_json",
    name: "card JSON",
    row: { ...card, fsrs_state: "not-json" },
    table: "cards",
  },
  {
    error: "FOREIGN KEY constraint failed",
    name: "card word foreign key",
    row: { ...card, word_id: "missing" },
    table: "cards",
  },
  {
    error: "FOREIGN KEY constraint failed",
    name: "card user foreign key",
    row: { ...card, user_id: "missing" },
    table: "cards",
  },
  {
    error: "UNIQUE constraint failed",
    name: "duplicate card",
    row: { ...card, word_id: "known" },
    table: "cards",
  },
  {
    error: "attempts_production",
    name: "attempt type",
    row: { ...guess, card_type: "recognition" },
    table: "attempts",
  },
  {
    error: "attempts_grading",
    name: "attempt phase",
    row: { ...guess, phase: "other" },
    table: "attempts",
  },
  {
    error: "attempts_grading",
    name: "rated guess",
    row: { ...guess, rating: 3 },
    table: "attempts",
  },
  {
    error: "attempts_grading",
    name: "guess repetition",
    row: { ...guess, rep_number: 1 },
    table: "attempts",
  },
  {
    error: "attempts_grading",
    name: "unrated recall",
    row: { ...recall, rating: null },
    table: "attempts",
  },
  {
    error: "attempts_grading",
    name: "recall rating range",
    row: { ...recall, rating: 5 },
    table: "attempts",
  },
  {
    error: "attempts_grading",
    name: "recall correctness",
    row: { ...recall, correct: 0 },
    table: "attempts",
  },
  {
    error: "attempts_grading",
    name: "failed recall correctness",
    row: { ...recall, rating: 1 },
    table: "attempts",
  },
  {
    error: "attempts_latency",
    name: "negative latency",
    row: { ...guess, latency_ms: -1 },
    table: "attempts",
  },
  {
    error: "attempts_latency",
    name: "excessive latency",
    row: { ...guess, latency_ms: 86_400_001 },
    table: "attempts",
  },
  {
    error: "attempts_json",
    name: "attempt JSON",
    row: { ...guess, state_before: "not-json" },
    table: "attempts",
  },
  {
    error: "FOREIGN KEY constraint failed",
    name: "attempt word foreign key",
    row: { ...guess, word_id: "missing" },
    table: "attempts",
  },
  {
    error: "FOREIGN KEY constraint failed",
    name: "attempt user foreign key",
    row: { ...guess, user_id: "missing" },
    table: "attempts",
  },
  {
    error: "UNIQUE constraint failed",
    name: "duplicate guess",
    row: { ...guess, word_id: "known" },
    table: "attempts",
  },
  {
    error: "stale_card_missing_guess",
    name: "missing guess",
    row: { ...recall, rep_number: 1, word_id: "unseen" },
    table: "attempts",
  },
  {
    error: "stale_card_missing_guess",
    name: "another user's guess",
    row: { ...recall, rep_number: 1, user_id: "other" },
    table: "attempts",
  },
  {
    error: "stale_card_revision",
    name: "stale revision",
    row: { ...recall, rep_number: 1 },
    table: "attempts",
  },
  {
    error: "stale_card_revision",
    name: "skipped revision",
    row: { ...recall, rep_number: 3 },
    table: "attempts",
  },
];

describe("populated D1 migration upgrade", () => {
  let temporary: Awaited<ReturnType<typeof temporaryConfig>>;
  let worker: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
  let binding: D1Database;
  let before: Awaited<ReturnType<typeof snapshot>>;

  beforeAll(async () => {
    temporary = await temporaryConfig();
    worker = await getPlatformProxy<{ DB: D1Database }>({
      configPath: temporary.configPath,
      persist: false,
      remoteBindings: false,
    });
    binding = worker.env.DB;
    await applyMigration(binding, "0000_initial_schema.sql");
    await binding.batch(
      [
        "INSERT INTO user (id,name,email,created_at,updated_at) VALUES ('learner','Learner','learner@example.com',1,2),('other','Other','other@example.com',1,2)",
        "INSERT INTO account (id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES ('account','learner','credential','learner','hash',1,2)",
        "INSERT INTO session (id,expires_at,token,created_at,updated_at,user_id) VALUES ('session',999999,'token',1,2,'learner')",
        "INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at) VALUES ('verification','email','value',999999,1,2)",
        "INSERT INTO settings (user_id,lang,new_per_day,day_rollover_hour) VALUES ('learner','fr',7,5)",
        "INSERT INTO words (id,lang,text,gloss,created_at) VALUES ('known','fr','chien','cane','2020-01-01T00:00:00.000Z'),('unseen','fr','chat','gatto','2020-01-02T00:00:00.000Z')",
        "INSERT INTO attempts (id,user_id,word_id,phase,typed,correct,rating,latency_ms,state_before,reviewed_at,rep_number,request) VALUES ('guess','learner','known','guess','',0,NULL,1000,'{\"reps\":0}','2026-09-10T09:00:00.000Z',0,'{}'),('recall','learner','known','recall','chien',1,3,2000,'{\"reps\":0}','2026-09-10T09:01:00.000Z',1,'{}')",
        "INSERT INTO cards (user_id,word_id,fsrs_state,revision) VALUES ('learner','known','{\"reps\":1,\"due\":\"2026-09-11T09:01:00.000Z\"}',1)",
      ].map((sql) => binding.prepare(sql))
    );
    before = await snapshot(binding);
    const files = await migrationFiles();
    for (const file of files.filter(
      (name) => name !== "0000_initial_schema.sql"
    )) {
      // Each historical migration depends on the previous schema version.
      // eslint-disable-next-line no-await-in-loop
      await applyMigration(binding, file);
    }
  });

  afterAll(async () => {
    try {
      await worker?.dispose();
    } finally {
      if (temporary) {
        await rm(temporary.directory, { force: true, recursive: true });
      }
    }
  });

  it("preserves every populated table while upgrading the initial schema", async () => {
    expect(before.every(({ rows }) => rows.length > 0)).toBe(true);
    expect(await snapshot(binding)).toEqual(before);
    const foreignKeys = await binding.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeys.results).toEqual([]);
  });

  it("adds usable rate limits with unique keys", async () => {
    await binding
      .prepare(
        "INSERT INTO rate_limit (id,key,count,last_request) VALUES ('limit','login:learner',2,1234)"
      )
      .run();
    expect(
      await binding.prepare("SELECT * FROM rate_limit").first<{
        count: number;
        id: string;
        key: string;
        last_request: number;
      }>()
    ).toEqual({
      count: 2,
      id: "limit",
      key: "login:learner",
      last_request: 1234,
    });
    await expect(
      binding
        .prepare(
          "INSERT INTO rate_limit (id,key,count,last_request) VALUES ('duplicate','login:learner',1,1235)"
        )
        .run()
    ).rejects.toThrow("UNIQUE constraint failed");
  });

  it.each([
    { column: "new_per_day", error: "settings_allowance", value: -1 },
    { column: "new_per_day", error: "settings_allowance", value: 101 },
    { column: "day_rollover_hour", error: "settings_rollover", value: -1 },
    { column: "day_rollover_hour", error: "settings_rollover", value: 24 },
  ])(
    "rejects out-of-range $column = $value through SQL",
    async ({ column, error, value }) => {
      await expect(
        binding
          .prepare(
            `UPDATE settings SET ${column} = ? WHERE user_id = 'learner'`
          )
          .bind(value)
          .run()
      ).rejects.toThrow(error);
      expect(await snapshot(binding)).toEqual(before);
    }
  );

  it.each([
    { column: "new_per_day", original: 7, value: 0 },
    { column: "new_per_day", original: 7, value: 100 },
    { column: "day_rollover_hour", original: 5, value: 0 },
    { column: "day_rollover_hour", original: 5, value: 23 },
  ])(
    "accepts the boundary $column = $value through SQL",
    async ({ column, original, value }) => {
      try {
        await binding
          .prepare(
            `UPDATE settings SET ${column} = ? WHERE user_id = 'learner'`
          )
          .bind(value)
          .run();
        expect(
          await binding
            .prepare(
              `SELECT ${column} AS value FROM settings WHERE user_id = 'learner'`
            )
            .first()
        ).toEqual({ value });
      } finally {
        await binding
          .prepare(
            `UPDATE settings SET ${column} = ? WHERE user_id = 'learner'`
          )
          .bind(original)
          .run();
      }
      expect(await snapshot(binding)).toEqual(before);
    }
  );

  it.each(rejectedRows)(
    "rejects $name through SQL",
    async ({ table, row, error }) => {
      const columns = Object.keys(row);
      await expect(
        binding
          .prepare(
            `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`
          )
          .bind(...Object.values(row))
          .run()
      ).rejects.toThrow(error);
      expect(await snapshot(binding)).toEqual(before);
    }
  );

  it.each([
    {
      error: "attempts_are_append_only",
      name: "update",
      sql: "UPDATE attempts SET typed = 'changed' WHERE id = 'guess'",
    },
    {
      error: "attempts_are_append_only",
      name: "delete",
      sql: "DELETE FROM attempts WHERE id = 'recall'",
    },
    {
      error: "FOREIGN KEY constraint failed",
      name: "word deletion",
      sql: "DELETE FROM words WHERE id = 'known'",
    },
    {
      error: "FOREIGN KEY constraint failed",
      name: "user deletion",
      sql: "DELETE FROM user WHERE id = 'learner'",
    },
  ])("protects populated history against $name", async ({ sql, error }) => {
    await expect(binding.prepare(sql).run()).rejects.toThrow(error);
    expect(await snapshot(binding)).toEqual(before);
  });
});

it("applies and reapplies migrations through local Wrangler with isolated state", async () => {
  const temporary = await temporaryConfig();
  const run = (args: string[]) =>
    execFileSync(
      "bun",
      [
        "run",
        "wrangler",
        "d1",
        ...args,
        "--local",
        "--config",
        temporary.configPath,
        "--persist-to",
        path.join(temporary.directory, "state"),
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf-8",
        env: {
          ...process.env,
          CI: "true",
          CLOUDFLARE_ACCOUNT_ID: "",
          CLOUDFLARE_API_TOKEN: "",
          WRANGLER_LOG_PATH: path.join(temporary.directory, "logs"),
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
      }
    );
  try {
    run(["migrations", "apply", "DB"]);
    run(["migrations", "apply", "DB"]);
    const result = v.parse(
      v.array(
        v.object({
          results: v.array(v.object({ kind: v.string(), name: v.string() })),
          success: v.boolean(),
        })
      ),
      JSON.parse(
        run([
          "execute",
          "DB",
          "--json",
          "--command",
          "SELECT name, 'migration' AS kind FROM d1_migrations UNION ALL SELECT name, type AS kind FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY kind, name",
        ])
      )
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.success).toBe(true);
    const rows = result[0]?.results ?? [];
    expect(
      rows.filter(({ kind }) => kind === "migration").map(({ name }) => name)
    ).toEqual(await migrationFiles());
    expect(
      rows.filter(({ kind }) => kind === "trigger").map(({ name }) => name)
    ).toEqual([
      "attempts_no_delete",
      "attempts_no_update",
      "attempts_recall_revision",
    ]);
    expect(
      rows.filter(({ kind }) => kind === "table").map(({ name }) => name)
    ).toEqual(expect.arrayContaining([...legacyTables, "rate_limit"]));
  } finally {
    await rm(temporary.directory, { force: true, recursive: true });
  }
}, 90_000);
