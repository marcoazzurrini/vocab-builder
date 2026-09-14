import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

// Same-origin cookies; no public database URL or service key in the browser.
export const authClient = createAuthClient({ plugins: [magicLinkClient()] });
