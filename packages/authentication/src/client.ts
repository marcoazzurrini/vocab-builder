import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import type { Identity } from "./identity";

// Same-origin cookies. No server configuration or database imports enter this entrypoint.
const client = createAuthClient({ plugins: [magicLinkClient()] });

export type SessionState = {
  user: Identity | null;
  isPending: boolean;
  error: Error | null;
};

export function useSession(): SessionState {
  const { data, isPending, error } = client.useSession();
  return {
    user: data ? { id: data.user.id, email: data.user.email, name: data.user.name } : null,
    isPending,
    error: error ? new Error(error.message ?? "Could not check the session.") : null,
  };
}

export async function requestLink(email: string, callbackURL = "/"): Promise<void> {
  const { error } = await client.signIn.magicLink({ email, callbackURL });
  if (error) throw new Error(error.message ?? "Could not send the sign-in link.");
}

export async function signOut(): Promise<void> {
  const { error } = await client.signOut();
  if (error) throw new Error(error.message ?? "Could not sign out.");
}
