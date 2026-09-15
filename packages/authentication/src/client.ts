import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import type { Identity } from "./identity";

// Same-origin cookies. No server configuration or database imports enter this entrypoint.
const client = createAuthClient({ plugins: [magicLinkClient()] });

export interface SessionState {
  user: Identity | null;
  isPending: boolean;
  error: Error | null;
}

export const useSession = (): SessionState => {
  const { data, isPending, error } = client.useSession();
  return {
    error: error
      ? new Error(error.message ?? "Could not check the session.")
      : null,
    isPending,
    user: data
      ? { email: data.user.email, id: data.user.id, name: data.user.name }
      : null,
  };
};

export const requestLink = async (
  email: string,
  callbackURL = "/"
): Promise<void> => {
  const { error } = await client.signIn.magicLink({ callbackURL, email });
  if (error) {
    throw new Error(error.message ?? "Could not send the sign-in link.");
  }
};

export const signOut = async (): Promise<void> => {
  const { error } = await client.signOut();
  if (error) {
    throw new Error(error.message ?? "Could not sign out.");
  }
};
