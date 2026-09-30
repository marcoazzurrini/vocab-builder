import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import type { D1Database } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";

import { compileCatalogue } from "./compile";
import { compileCurriculum } from "./compile-curriculum";
import { importRemoteCurriculum } from "./remote";

// Local by default. Remote family imports require an explicit flag and a verified backup.
if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      activate: { default: false, type: "boolean" },
      "allow-drafts": { default: false, type: "boolean" },
      config: { type: "string" },
      families: { default: false, type: "boolean" },
      remote: { default: false, type: "boolean" },
      resource: { type: "string" },
    },
  });
  if (!values.config || positionals.length > 1) {
    throw new Error("Provide --config and at most one catalogue JSON file.");
  }
  if (values.remote && !values.families) {
    throw new Error("Remote catalogue imports require --families.");
  }
  const input =
    positionals[0] ??
    new URL(
      values.families ? "curriculum-fr-it.json" : "fr-it-1000.json",
      import.meta.url
    );
  const options = {
    activate: values.activate && !values.remote,
    allowDrafts: values["allow-drafts"],
  };
  const compiled = values.families
    ? compileCurriculum(
        JSON.parse(
          await readFile(
            values.resource ?? new URL("family-resource.json", import.meta.url),
            "utf-8"
          )
        ),
        JSON.parse(await readFile(input, "utf-8")),
        options
      )
    : compileCatalogue(JSON.parse(await readFile(input, "utf-8")), options);
  const config = path.resolve(values.config);
  if (values.remote && "targets" in compiled) {
    await importRemoteCurriculum(compiled, config, values.activate);
    process.exit(0);
  }
  const directory = path.dirname(config);
  const backupDirectory = path.join(directory, ".wrangler/catalogue-backups");
  await mkdir(backupDirectory, { recursive: true });
  const backup = path.join(backupDirectory, `before-import-${Date.now()}.sql`);
  execFileSync(
    "bun",
    [
      "run",
      "wrangler",
      "d1",
      "export",
      "DB",
      "--local",
      "--config",
      config,
      "--output",
      backup,
    ],
    { cwd: directory, stdio: "inherit" }
  );
  const worker = await getPlatformProxy<{ DB: D1Database }>({
    configPath: config,
    persist: { path: path.join(directory, ".wrangler/state/v3") },
    remoteBindings: false,
  });
  try {
    const binding = worker.env.DB;
    const before = await binding
      .prepare(
        "SELECT (SELECT count(*) FROM cards) cards, (SELECT count(*) FROM attempts) attempts"
      )
      .first<{ cards: number; attempts: number }>();
    // D1 batches are transactional: either the complete catalogue becomes visible or none does.
    await binding.batch(
      compiled.statements.map((s) => binding.prepare(s.sql).bind(...s.params))
    );
    const after = await binding
      .prepare(
        "SELECT (SELECT count(*) FROM cards) cards, (SELECT count(*) FROM attempts) attempts"
      )
      .first<{ cards: number; attempts: number }>();
    const total = await binding
      .prepare("SELECT count(*) n FROM catalogue_list_members WHERE list_id=?")
      .bind(compiled.data.id)
      .first<number>("n");
    console.log(
      JSON.stringify(
        {
          activated: values.activate,
          after,
          backup,
          before,
          cues: "Machine-authored pilot; dictionary/human verification remains outstanding.",
          database: "local only",
          families: compiled.families,
          familyMembers: compiled.familyMembers,
          forms: "forms" in compiled ? compiled.forms : undefined,
          list: compiled.data.id,
          members: total,
          targets: "targets" in compiled ? compiled.targets : undefined,
        },
        null,
        2
      )
    );
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(
        "Learning-history counts changed during import; inspect backup and concurrent clients."
      );
    }
  } finally {
    await worker.dispose();
  }
}
