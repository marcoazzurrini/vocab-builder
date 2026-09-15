import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "**/.generated/**",
    "**/.tanstack/**",
    "**/exports/**",
    "packages/database/migrations/**",
    "packages/database/tests/fixtures/legacy-catalogue/**",
  ],
});
