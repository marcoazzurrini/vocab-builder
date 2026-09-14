import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("./setup-local.mjs", import.meta.url));
it("creates private local settings without overwriting an existing secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vocab-auth-"));
  try {
    const target = join(directory, ".dev.vars");
    execFileSync("bun", [script, target, "learner@example.com"], { stdio: "pipe" });
    const original = await readFile(target, "utf8");
    expect(original).toContain("AUTH_EMAIL_MODE=log");
    expect(original).toMatch(/BETTER_AUTH_SECRET=[a-f0-9]{64}/);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(() => execFileSync("bun", [script, target], { stdio: "pipe" })).toThrow();
    expect(await readFile(target, "utf8")).toBe(original);
    expect(() =>
      execFileSync("bun", [script, join(directory, "invalid"), "bad\nemail"], { stdio: "pipe" }),
    ).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
