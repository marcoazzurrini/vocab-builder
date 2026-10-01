import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
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
    const rawBinding = worker.env.DB;
    // Miniflare serializes proxy arguments before asynchronous dispatch. Keep
    // statement proxies alive until the batch settles so its finalizer cannot
    // release their remote handles while the request is still in flight.
    const pendingBatches = new Map<symbol, D1PreparedStatement[]>();
    const binding: D1Database = {
      batch: async <T>(statements: D1PreparedStatement[]) => {
        const operation = Symbol("pending batch");
        pendingBatches.set(operation, statements);
        try {
          return await rawBinding.batch<T>(statements);
        } finally {
          pendingBatches.delete(operation);
        }
      },
      dump: () => rawBinding.dump(),
      exec: (query) => rawBinding.exec(query),
      prepare: (query) => rawBinding.prepare(query),
      withSession: (bookmark) => rawBinding.withSession(bookmark),
    };
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
