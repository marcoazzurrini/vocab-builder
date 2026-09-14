import { defineConfig } from "drizzle-kit";

// Generate reviewed SQL here; Wrangler applies it to local or remote D1.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./migrations",
});
