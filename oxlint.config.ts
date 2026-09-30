import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, react, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "**/.generated/**",
    "**/.tanstack/**",
    "**/exports/**",
    "packages/database/migrations/**",
    "packages/i18n/src/locales/**/*.js",
    "packages/database/tests/fixtures/legacy-catalogue/**",
  ],
  overrides: [
    {
      // Preserve upstream shadcn declarations and variant exports without weakening behavior checks.
      files: ["apps/web/src/components/ui/**/*.tsx"],
      rules: {
        "eslint/func-style": "off",
        "react/function-component-definition": "off",
        "react/only-export-components": [
          "error",
          {
            allowConstantExport: true,
            allowExportNames: [
              "buttonVariants",
              "badgeVariants",
              "toggleVariants",
            ],
          },
        ],
      },
    },
    ...(vitest.overrides ?? []).map((override) => ({
      ...override,
      files: override.files.map((pattern) => `apps/web/${pattern}`),
    })),
    {
      // TanStack Router requires this exact root-route filename.
      files: ["apps/web/src/routes/__root.tsx"],
      rules: { "unicorn/filename-case": "off" },
    },
  ],
  rules: {
    "react/only-export-components": [
      "error",
      { allowConstantExport: true, allowExportNames: ["Route"] },
    ],
  },
});
