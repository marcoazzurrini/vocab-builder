import { describe, expect, it } from "vitest";

// Toolchain check, not a real test — it asserts that Vitest resolves, that
// TypeScript compiles a test file under the app tsconfig, and that `npm test`
// exits non-zero on failure. Delete it the moment there is real logic to cover;
// the first candidate is the answer comparison in the README.
describe("test harness", () => {
  it("runs typed assertions", () => {
    const normalised: string = "FENÊTRE ".trim().toLowerCase();
    expect(normalised).toBe("fenêtre");
  });
});
