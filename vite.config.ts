import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Node by default: the logic worth testing first — answer comparison and
    // the session rule — is pure and has no DOM, and keeping it that way is
    // most of why it is testable at all. The few files that do need a DOM ask
    // for one with `// @vitest-environment jsdom` at the top.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
