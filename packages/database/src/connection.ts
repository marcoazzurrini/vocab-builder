import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";

import * as catalogueSchema from "./catalogue-schema";
import * as curriculumSchema from "./curriculum-schema";
import * as presentationSchema from "./presentation-schema";
import * as schema from "./schema";

export type DatabaseBinding = D1Database;

export const connect = (binding: DatabaseBinding) =>
  drizzle(binding, {
    schema: {
      ...schema,
      ...catalogueSchema,
      ...curriculumSchema,
      ...presentationSchema,
    },
  });
export type Database = ReturnType<typeof connect>;
