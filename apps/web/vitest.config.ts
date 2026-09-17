import { fileURLToPath } from "node:url";

import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const linguiOptions = {
  configPath: fileURLToPath(import.meta.resolve("@vocab/i18n/config")),
};

export default defineConfig({
  plugins: [
    react(),
    lingui({ ...linguiOptions, failOnCompileError: true, failOnMissing: true }),
    babel({ presets: [linguiTransformerBabelPreset({}, linguiOptions)] }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
  },
  test: {
    environment: "node",
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
