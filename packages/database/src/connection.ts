import type { D1Database } from "@cloudflare/workers-types";
import { drizzle } from "drizzle-orm/d1";

import * as schema from "./schema";

export type DatabaseBinding = D1Database;

export const connect = (binding: DatabaseBinding) =>
  drizzle(binding, { schema });
export type Database = ReturnType<typeof connect>;
