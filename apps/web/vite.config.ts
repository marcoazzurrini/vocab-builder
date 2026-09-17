import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const linguiOptions = {
  configPath: fileURLToPath(import.meta.resolve("@vocab/i18n/config")),
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    lingui({ ...linguiOptions, failOnCompileError: true, failOnMissing: true }),
    tanstackStart(),
    react(),
    babel({ presets: [linguiTransformerBabelPreset({}, linguiOptions)] }),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
  },
});
