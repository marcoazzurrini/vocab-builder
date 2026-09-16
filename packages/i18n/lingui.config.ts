import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  catalogs: [
    {
      include: ["<rootDir>/../../apps/web/src", "<rootDir>/src"],
      path: "<rootDir>/src/locales/{locale}/messages",
    },
  ],
  format: formatter({ lineNumbers: false }),
  locales: ["en", "it"],
  rootDir: import.meta.dirname,
  sourceLocale: "en",
});
