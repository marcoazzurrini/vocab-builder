import { createServer } from "node:http";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("./export-supabase-words.mjs", import.meta.url));

it("exports all pages even when the source caps pages below the requested limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vocab-export-test-"));
  const output = join(directory, "words.json");
  const source = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: `mot-${i}` }));
  let requests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    expect(url.pathname).toBe("/rest/v1/words");
    expect(request.method).toBe("GET");
    expect(request.headers.prefer).toBe("count=exact");
    const start = Number(url.searchParams.get("offset"));
    const rows = source.slice(start, start + 2);
    requests++;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Range": `${start}-${start + rows.length - 1}/${source.length}`,
    });
    response.end(JSON.stringify(rows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start.");
  try {
    const env = {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${address.port}`,
      SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-credential",
    };
    await run(process.execPath, [script, output], { env });
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(source);
    expect(requests).toBe(3);
    await expect(run(process.execPath, [script, output], { env })).rejects.toThrow();
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(source);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not write a partial export when pagination fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vocab-export-test-"));
  const output = join(directory, "words.json");
  const server = createServer((request, response) => {
    const offset = new URL(request.url!, "http://localhost").searchParams.get("offset");
    if (offset !== "0") {
      response.writeHead(500);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Content-Range": "0-0/2" });
    response.end(JSON.stringify([{ id: "1" }]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not start.");
  try {
    await expect(
      run(process.execPath, [script, output], {
        env: {
          ...process.env,
          SUPABASE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_ROLE_KEY: "test-only",
        },
      }),
    ).rejects.toThrow();
    await expect(access(output)).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
