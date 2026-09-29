import { createHash } from "node:crypto";

import type { CurationRow, Curriculum, formLessons } from "./curriculum";
import type { FamilyResource } from "./families";
import type { EditorialEntry } from "./presentations";

type CatalogueHashInput =
  | FamilyResource
  | Curriculum
  | readonly (string | number | null)[]
  | readonly [CurationRow[], typeof formLessons]
  | {
      editorial: readonly (readonly [string, EditorialEntry])[];
      grammar: Readonly<Record<string, string>>;
      policy: string;
      version: number;
    };

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Gather the JSON property names first, then let JSON.stringify apply their
// canonical order at every object level. Array order remains significant.
export const contentHash = (input: CatalogueHashInput): string => {
  const keys = new Set<string>();
  JSON.stringify(
    input,
    function collectKey(this: JsonValue, key: string, value: JsonValue) {
      if (!Array.isArray(this)) {
        keys.add(key);
      }
      return value;
    }
  );
  const encoded = JSON.stringify(
    input,
    [...keys].toSorted((a, b) => a.localeCompare(b, "en"))
  );
  return createHash("sha256").update(encoded).digest("hex");
};
