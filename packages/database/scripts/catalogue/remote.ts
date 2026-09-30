import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import type { Statement } from "./compile";
import type { compileCurriculum } from "./compile-curriculum";
import { PRESENTATION_VERSION } from "./presentations";

type CompiledCurriculum = ReturnType<typeof compileCurriculum>;

const literalSchema = v.union([
  v.pipe(
    v.string(),
    v.check((text) => !text.includes("\0")),
    v.transform((text) => `'${text.replaceAll("'", "''")}'`)
  ),
  v.pipe(v.number(), v.finite(), v.transform(String)),
  v.pipe(
    v.null_(),
    v.transform(() => "NULL")
  ),
]);

/** Only compiler-owned SQL templates are accepted, never arbitrary user SQL. */
export const renderStatements = (statements: Statement[]) =>
  statements
    .map(({ sql, params }) => {
      const parts = sql.split("?");
      if (parts.length !== params.length + 1) {
        throw new Error("SQL placeholder count does not match parameters.");
      }
      let rendered = parts[0] ?? "";
      for (const [index, param] of params.entries()) {
        const literal = v.safeParse(literalSchema, param);
        if (!literal.success) {
          throw new Error("Unsupported SQL parameter.");
        }
        rendered += `${literal.output}${parts[index + 1]}`;
      }
      return `${rendered};`;
    })
    .join("\n");

const protectedTables = [
  "account",
  "attempts",
  "cards",
  "session",
  "settings",
  "user",
  "verification",
  "rate_limit",
  "teachings",
  "d1_migrations",
];

export const membershipSql = (compiled: CompiledCurriculum) =>
  renderStatements([
    {
      params: [compiled.data.id, compiled.data.sourceId, PRESENTATION_VERSION],
      sql: `WITH curriculum AS (SELECT * FROM catalogue_curricula WHERE id=?),
    steps AS (SELECT s.* FROM catalogue_curriculum_steps s JOIN curriculum c ON c.id=s.curriculum_id),
    ranks AS (SELECT r.* FROM catalogue_family_ranks r JOIN curriculum c ON c.resource_id=r.resource_id),
    lemmas AS (SELECT DISTINCT m.entry_id FROM catalogue_family_members m JOIN ranks r ON r.family_id=m.family_id)
  SELECT
    (SELECT count(*) FROM catalogue_list_members m JOIN curriculum c ON c.id=m.list_id) members,
    (SELECT count(*) FROM steps) targets,
    (SELECT count(DISTINCT family_id) FROM steps) taught_families,
    (SELECT count(*) FROM ranks) families,
    (SELECT count(*) FROM lemmas) lemmas,
    (SELECT count(*) FROM catalogue_forms f JOIN lemmas l ON l.entry_id=f.entry_id WHERE f.source_id=?) forms,
    (SELECT count(*) FROM steps WHERE form_id IS NOT NULL) selected_forms,
    (SELECT count(*) FROM steps s JOIN catalogue_prompts p ON p.id=s.prompt_id JOIN words w ON w.id=p.word_id) projections,
    (SELECT count(*) FROM steps s JOIN catalogue_presentations p ON p.prompt_id=s.prompt_id WHERE p.version=?) presentations,
    (SELECT content_hash FROM curriculum) content_hash,
    (SELECT sha256 FROM catalogue_sources s JOIN curriculum c ON c.resource_id=s.id) resource_hash`,
    },
  ]);

export const membershipSchema = v.object({
  content_hash: v.string(),
  families: v.number(),
  forms: v.number(),
  lemmas: v.number(),
  members: v.number(),
  presentations: v.number(),
  projections: v.number(),
  resource_hash: v.string(),
  selected_forms: v.number(),
  targets: v.number(),
  taught_families: v.number(),
});

type Membership = v.InferOutput<typeof membershipSchema>;

export const verifyMembership = (
  counts: Membership,
  compiled: CompiledCurriculum
) => {
  if (
    counts.members !== compiled.targets ||
    counts.targets !== compiled.targets ||
    counts.presentations !== compiled.targets ||
    counts.projections !== compiled.targets ||
    counts.families !== compiled.families ||
    counts.taught_families !== compiled.families ||
    counts.lemmas !== compiled.familyMembers ||
    counts.forms !== compiled.forms ||
    counts.selected_forms !== compiled.targets - compiled.familyMembers ||
    counts.content_hash !== compiled.data.contentHash ||
    counts.resource_hash !== compiled.data.resourceHash
  ) {
    throw new Error(
      "Imported curriculum counts or hashes do not match the compiled resource."
    );
  }
  return counts;
};

/** Rehearse against the production backup without writing any live data. */
export const rehearseImport = (
  backup: string,
  sql: string,
  compiled: CompiledCurriculum
) => {
  const database = new Database(":memory:");
  try {
    database.exec(backup);
    database.exec("PRAGMA foreign_keys=ON");
    const tables = protectedTables.filter((table) =>
      database
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    );
    const snapshot = () =>
      JSON.stringify(
        tables.map((table) =>
          database.query(`SELECT * FROM ${table} ORDER BY rowid`).all()
        )
      );
    const before = snapshot();
    // Frequency rank may change; every historical identity and reveal field must survive.
    const words = database
      .query(
        "SELECT id,lang,text,gloss,gloss_lang,hint,image,kind,created_at FROM words ORDER BY id"
      )
      .all();
    database.exec(sql);
    if (snapshot() !== before) {
      throw new Error(
        "Import would modify authentication or learning-history data."
      );
    }
    for (const word of words) {
      const row = v.parse(v.object({ id: v.string() }), word);
      const after = database
        .query(
          "SELECT id,lang,text,gloss,gloss_lang,hint,image,kind,created_at FROM words WHERE id=?"
        )
        .get(row.id);
      if (JSON.stringify(after) !== JSON.stringify(word)) {
        throw new Error(
          "Import would rewrite an existing word identity or teaching payload."
        );
      }
    }
    if (database.query("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("Import would create foreign-key violations.");
    }
    return verifyMembership(
      v.parse(membershipSchema, database.query(membershipSql(compiled)).get()),
      compiled
    );
  } finally {
    database.close();
  }
};

const resultsSchema = v.array(
  v.object({
    results: v.array(v.unknown()),
    success: v.literal(true),
  })
);

const assertStagedPlan = (compiled: CompiledCurriculum) => {
  if (
    compiled.statements.some((statement) =>
      statement.sql.startsWith("UPDATE catalogue_lists")
    )
  ) {
    throw new Error("Remote import must compile without activation.");
  }
};

/** Called only after the backup has been exported and rehearsed successfully. */
export const stageAndActivate = async (
  compiled: CompiledCurriculum,
  activate: boolean,
  query: (sql: string) => unknown[],
  execute: (sql: string, phase: "catalogue" | "activate") => Promise<void>
) => {
  assertStagedPlan(compiled);
  const historySql =
    "SELECT (SELECT count(*) FROM cards) cards, (SELECT count(*) FROM attempts) attempts, (SELECT count(*) FROM teachings) teachings";
  const historySchema = v.object({
    attempts: v.number(),
    cards: v.number(),
    teachings: v.number(),
  });
  const before = v.parse(historySchema, query(historySql)[0]);
  await execute(renderStatements(compiled.statements), "catalogue");
  const counts = verifyMembership(
    v.parse(membershipSchema, query(membershipSql(compiled))[0]),
    compiled
  );
  if (query("PRAGMA foreign_key_check").length > 0) {
    throw new Error(
      "Remote foreign-key check failed; curriculum not activated."
    );
  }
  const after = v.parse(historySchema, query(historySql)[0]);
  // Concurrent practice may append history; the importer must never remove it.
  if (
    after.cards < before.cards ||
    after.attempts < before.attempts ||
    after.teachings < before.teachings
  ) {
    throw new Error(
      "Learning-history counts decreased; curriculum not activated."
    );
  }
  if (activate) {
    await execute(
      renderStatements([
        {
          params: [compiled.data.id],
          sql: "UPDATE catalogue_lists SET is_default=0 WHERE (language,prompt_language)=(SELECT language,prompt_language FROM catalogue_lists WHERE id=?)",
        },
        {
          params: [compiled.data.id],
          sql: "UPDATE catalogue_lists SET is_default=1 WHERE id=?",
        },
      ]),
      "activate"
    );
    const [active] = query(
      renderStatements([
        {
          params: [compiled.data.id],
          sql: "SELECT is_default FROM catalogue_lists WHERE id=?",
        },
      ])
    );
    v.parse(v.object({ is_default: v.literal(1) }), active);
  }
  return { after, before, counts };
};

export const importRemoteCurriculum = async (
  compiled: CompiledCurriculum,
  config: string,
  activate: boolean
) => {
  const directory = path.dirname(config);
  const backupDirectory = path.join(directory, ".wrangler/catalogue-backups");
  await mkdir(backupDirectory, { mode: 0o700, recursive: true });
  await chmod(backupDirectory, 0o700);
  const prefix = path.join(backupDirectory, `remote-${Date.now()}`);
  const backup = `${prefix}-before.sql`;
  const execute = (...args: string[]) =>
    execFileSync(
      "bun",
      ["run", "wrangler", "d1", ...args, "--remote", "--config", config],
      { cwd: directory, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 }
    );
  const query = (sql: string) => {
    const results = v.parse(
      resultsSchema,
      JSON.parse(execute("execute", "DB", "--json", "--command", sql))
    );
    return results.flatMap((result) => result.results);
  };
  const sql = renderStatements(compiled.statements);
  // The remote compiler stages only. Activation is a separate, verified operation.
  assertStagedPlan(compiled);
  execute("export", "DB", "--output", backup);
  await chmod(backup, 0o600);
  const backupStats = await stat(backup);
  if (backupStats.size === 0) {
    throw new Error("Remote backup is empty; import cancelled.");
  }
  const expected = rehearseImport(
    await readFile(backup, "utf-8"),
    sql,
    compiled
  );
  console.log(
    JSON.stringify({
      backup,
      database: "remote",
      expected,
      stage: "backup and rehearsal verified",
    })
  );
  const { before, after, counts } = await stageAndActivate(
    compiled,
    activate,
    query,
    async (content, phase) => {
      const file = `${prefix}-${phase}.sql`;
      await writeFile(file, content, { mode: 0o600 });
      // Remote --file is a blocking import. Do not split it into independently committed batches.
      execute("execute", "DB", "--file", file, "--yes");
    }
  );
  console.log(
    JSON.stringify(
      {
        activated: activate,
        after,
        backup,
        before,
        counts,
        cues: "Machine-authored drafts; independent linguistic review remains outstanding.",
        database: "remote",
        list: compiled.data.id,
      },
      null,
      2
    )
  );
};
