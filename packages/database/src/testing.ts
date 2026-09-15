import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { getPlatformProxy } from "wrangler";

import { connect } from "./connection";

/** Real local D1, isolated from development state, credentials, and remote bindings. */
export const testDatabase = async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "vocab-d1-test-"));
  const configPath = path.join(temporary, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      compatibility_date: "2026-09-11",
      d1_databases: [
        {
          binding: "DB",
          database_id: "00000000-0000-0000-0000-000000000000",
          database_name: "test",
        },
      ],
      name: "vocab-builder-test",
    })
  );
  let worker:
    | Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>
    | undefined;
  const close = async () => {
    try {
      await worker?.dispose();
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  };
  try {
    worker = await getPlatformProxy<{ DB: D1Database }>({
      configPath,
      persist: false,
      remoteBindings: false,
    });
    const binding = worker.env.DB;
    const directory = new URL("../migrations/", import.meta.url);
    const entries = await readdir(directory);
    const files = entries.filter((file) => file.endsWith(".sql")).toSorted();
    const sources = await Promise.all(
      files.map((file) => readFile(new URL(file, directory), "utf-8"))
    );
    for (const source of sources) {
      for (const statement of source
        .split("--> statement-breakpoint")
        .filter((part) => part.trim())) {
        // Each migration statement depends on the schema created by previous statements.
        // eslint-disable-next-line no-await-in-loop
        await binding.prepare(statement).run();
      }
    }
    return { binding, close, db: connect(binding) };
  } catch (error) {
    await close();
    throw error;
  }
};
