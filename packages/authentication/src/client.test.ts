import { beforeEach, describe, expect, it, mock } from "bun:test";

interface SessionSnapshot {
  data: {
    user: { id: string; email: string; name: string; emailVerified: boolean };
    session: { token: string };
  } | null;
  error: { message?: string } | null;
  isPending: boolean;
}
interface OperationResult {
  error: { message?: string } | null;
}

let snapshot: SessionSnapshot;
const magicLink = mock(
  (_input: { callbackURL: string; email: string }): Promise<OperationResult> =>
    Promise.resolve({ error: null })
);
const logout = mock((): Promise<OperationResult> =>
  Promise.resolve({ error: null })
);

// This package runs in its own Bun process. Mock only the React client boundary;
// server tests continue to exercise the actual Better Auth engine and D1 adapter.
mock.module("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: { magicLink },
    signOut: logout,
    useSession: () => snapshot,
  }),
}));
const { requestLink, signOut, useSession } = await import("./client");

beforeEach(() => {
  snapshot = { data: null, error: null, isPending: false };
  magicLink.mockReset();
  magicLink.mockResolvedValue({ error: null });
  logout.mockReset();
  logout.mockResolvedValue({ error: null });
});

describe("session projection", () => {
  it.each([false, true])(
    "preserves anonymous/pending state (pending: %s)",
    (isPending) => {
      snapshot.isPending = isPending;
      expect(useSession()).toEqual({ error: null, isPending, user: null });
    }
  );
  it("exposes only public identity fields", () => {
    snapshot.data = {
      session: { token: "must-not-leak" },
      user: {
        email: "learner@example.com",
        emailVerified: true,
        id: "user-1",
        name: "Learner",
      },
    };
    expect(useSession()).toEqual({
      error: null,
      isPending: false,
      user: { email: "learner@example.com", id: "user-1", name: "Learner" },
    });
  });
  it.each(["Session unavailable", undefined])(
    "maps session errors with fallback: %j",
    (message) => {
      snapshot.error = { message };
      expect(useSession().error).toEqual(
        new Error(message ?? "Could not check the session.")
      );
    }
  );
});

describe("client commands", () => {
  it.each([undefined, "/practice"])(
    "forwards email and callback: %j",
    async (callbackURL) => {
      await expect(
        requestLink("learner@example.com", callbackURL)
      ).resolves.toBeUndefined();
      expect(magicLink).toHaveBeenCalledWith({
        callbackURL: callbackURL ?? "/",
        email: "learner@example.com",
      });
    }
  );
  it.each(["Delivery unavailable", undefined])(
    "maps requestLink errors with fallback: %j",
    async (message) => {
      magicLink.mockResolvedValue({ error: { message } });
      await expect(requestLink("learner@example.com")).rejects.toThrow(
        message ?? "Could not send the sign-in link."
      );
    }
  );
  it("signs out", async () => {
    await expect(signOut()).resolves.toBeUndefined();
    expect(logout).toHaveBeenCalledTimes(1);
  });
  it.each(["Sign-out unavailable", undefined])(
    "maps signOut errors with fallback: %j",
    async (message) => {
      logout.mockResolvedValue({ error: { message } });
      await expect(signOut()).rejects.toThrow(message ?? "Could not sign out.");
    }
  );
});
