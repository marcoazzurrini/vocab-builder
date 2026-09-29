import { defineConfig } from "drizzle-kit";

// Generate reviewed SQL here; Wrangler applies it to local or remote D1.
export default defineConfig({
  dialect: "sqlite",
  out: "./migrations",
  schema: [
    "./src/schema.ts",
    "./src/catalogue-schema.ts",
    "./src/curriculum-schema.ts",
    "./src/presentation-schema.ts",
  ],
});
