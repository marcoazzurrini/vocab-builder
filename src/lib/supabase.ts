import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Vite silently substitutes `undefined` for a missing VITE_* value, which then
// fails much later as an opaque network error. Failing at startup instead names
// the actual problem.
if (!url || !publishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. " +
      "They live in .env, which is committed — see the comment in that file.",
  );
}

export const supabase = createClient(url, publishableKey);

/**
 * Where a magic link should return you.
 *
 * Always the origin you asked from, so the same build works on localhost and on
 * the deployed Worker. Supabase only honours origins listed in
 * `additional_redirect_urls` in supabase/config.toml — and an unlisted one fails
 * *silently*: the email arrives, the link appears to do nothing, and no error
 * surfaces anywhere.
 */
export const redirectTo = () => window.location.origin;
