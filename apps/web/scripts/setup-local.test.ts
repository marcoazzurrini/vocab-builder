import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("setup-local.mjs", import.meta.url));

describe("local development settings", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "vocab-auth-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("creates private local settings without overwriting an existing secret", async () => {
    const target = path.join(directory, ".dev.vars");
    execFileSync("bun", [script, target, "learner@example.com"], {
      stdio: "pipe",
    });
    const original = await readFile(target, "utf-8");
    expect(original).toContain("AUTH_EMAIL_MODE=log");
    expect(original).toMatch(/BETTER_AUTH_SECRET=[a-f0-9]{64}/u);
    const { mode } = await stat(target);
    expect(mode % 0o1000).toBe(0o600);
    expect(() =>
      execFileSync("bun", [script, target], { stdio: "pipe" })
    ).toThrow("EEXIST");
    await expect(readFile(target, "utf-8")).resolves.toBe(original);
  });

  it("rejects an invalid email address", () => {
    expect(() =>
      execFileSync(
        "bun",
        [script, path.join(directory, "invalid"), "bad\nemail"],
        {
          stdio: "pipe",
        }
      )
    ).toThrow("Provide a valid email address.");
  });
});
