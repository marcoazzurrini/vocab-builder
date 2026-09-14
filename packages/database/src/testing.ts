import { readFile, readdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import type { D1Database } from "@cloudflare/workers-types";
import { connect } from "./connection";

/** Real local D1, isolated from development state, credentials, and remote bindings. */
export async function testDatabase() {
  const temporary = await mkdtemp(join(tmpdir(), "vocab-d1-test-"));
  const configPath = join(temporary, "wrangler.json");
  await writeFile(
    configPath,
    JSON.stringify({
      name: "vocab-builder-test",
      compatibility_date: "2026-09-11",
      d1_databases: [
        {
          binding: "DB",
          database_name: "test",
          database_id: "00000000-0000-0000-0000-000000000000",
        },
      ],
    }),
  );
  let worker: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  const close = async () => {
    try {
      await worker?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
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
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const source = await readFile(new URL(file, directory), "utf8");
      for (const statement of source
        .split("--> statement-breakpoint")
        .filter((part) => part.trim())) {
        await binding.prepare(statement).run();
      }
    }
    return { binding, db: connect(binding), close };
  } catch (error) {
    await close();
    throw error;
  }
}
