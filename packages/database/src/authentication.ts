import { drizzleAdapter } from "@better-auth/drizzle-adapter";

import { connect } from "./connection";
import type { DatabaseBinding } from "./connection";
import { user, account, session, verification, rateLimit } from "./schema";

/** Adapter-specific bridge. Authentication never needs physical tables or a raw SQL client. */
export const createAuthenticationAdapter = (binding: DatabaseBinding) =>
  drizzleAdapter(connect(binding), {
    provider: "sqlite",
    schema: { account, rateLimit, session, user, verification },
    transaction: false,
  });
