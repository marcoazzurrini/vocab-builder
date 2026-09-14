import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBoundaries } from "./check-boundaries";

let root: string;
function write(path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vocab-boundaries-"));
  for (const [path, name, dependencies, exports] of [
    [
      "apps/web",
      "@vocab/web",
      {
        "@vocab/database": "workspace:*",
        "@vocab/authentication": "workspace:*",
        "@vocab/spaced-repetition": "workspace:*",
      },
      {},
    ],
    [
      "packages/database",
      "@vocab/database",
      { "@vocab/spaced-repetition": "workspace:*" },
      { ".": "./src/index.ts", "./testing": "./src/testing.ts" },
    ],
    [
      "packages/authentication",
      "@vocab/authentication",
      { "@vocab/database": "workspace:*" },
      { "./server": "./src/server.ts", "./client": "./src/client.ts" },
    ],
    [
      "packages/spaced-repetition",
      "@vocab/spaced-repetition",
      {},
      { ".": "./src/index.ts", "./server": "./src/server.ts" },
    ],
  ] as const)
    write(`${path}/package.json`, JSON.stringify({ name, dependencies, exports }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workspace boundaries", () => {
  it("allows declared public interfaces and the TanStack transport seam", () => {
    write("apps/web/src/App.tsx", 'import { useSession } from "@vocab/authentication/client";');
    write(
      "apps/web/src/features/practice/transport.ts",
      'import { getSnapshot } from "../../server/functions";',
    );
    write("apps/web/src/server/services.ts", 'import { createDatabase } from "@vocab/database";');
    write(
      "packages/authentication/src/server.test.ts",
      'import { testDatabase } from "@vocab/database/testing";',
    );
    expect(checkBoundaries(root)).toEqual([]);
  });

  it("rejects direct and relative imports of internal source", () => {
    write(
      "apps/web/src/App.ts",
      'import "@vocab/database/src/schema"; import "../../../packages/database/src/schema";',
    );
    expect(checkBoundaries(root).join("\n")).toMatch(/Not a public package export/);
    expect(checkBoundaries(root).join("\n")).toMatch(/relative cross-workspace import/);
  });

  it("checks re-exports, dynamic imports, and require calls", () => {
    write(
      "apps/web/src/App.ts",
      'export * from "@vocab/authentication/server"; void import("@vocab/database"); require("ts-fsrs");',
    );
    const errors = checkBoundaries(root).join("\n");
    expect(errors).toMatch(/Server-only entrypoint/);
    expect(errors).toMatch(/Undeclared dependency/);
    expect(errors).toMatch(/owning module/);
  });

  it("rejects reverse dependencies and test infrastructure in production", () => {
    write("packages/spaced-repetition/src/index.ts", 'import "@vocab/database";');
    write("packages/database/src/index.ts", 'import "@vocab/web";');
    write("packages/authentication/src/server.ts", 'import "@vocab/database/testing";');
    const errors = checkBoundaries(root).join("\n");
    expect(errors).toMatch(/learning engine cannot depend/);
    expect(errors).toMatch(/cannot depend on an application/);
    expect(errors).toMatch(/Test utilities cannot enter production/);
  });

  it("keeps authentication implementation and Worker bindings out of client code", () => {
    write("packages/authentication/src/client.ts", 'import "./server"; import "@vocab/database";');
    write("apps/web/src/App.ts", 'import "./server/services"; import "cloudflare:workers";');
    const errors = checkBoundaries(root).join("\n");
    expect(errors).toMatch(/Authentication client cannot import server implementation/);
    expect(errors).toMatch(/Authentication client cannot depend on database/);
    expect(errors).toMatch(/Browser code cannot import server implementation/);
    expect(errors).toMatch(/Worker bindings are server-only/);
  });
});
