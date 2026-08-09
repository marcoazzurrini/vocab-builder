import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // The logic worth testing first — answer comparison and the session
    // scheduler — is pure and has no DOM. Switch to jsdom when there are
    // components whose behaviour is worth asserting.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
