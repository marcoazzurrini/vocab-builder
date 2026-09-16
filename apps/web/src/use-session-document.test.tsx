// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import type { SessionState } from "@vocab/authentication/client";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSessionDocument } from "./use-session-document";

const user = { email: "learner@example.com", id: "u1", name: "" };
const settled = (identity: SessionState["user"]): SessionState => ({
  error: null,
  isPending: false,
  user: identity,
});

const observe = (documentUserId: string | null, session: SessionState) => {
  const reload = vi.fn<() => void>();
  const hook = renderHook(
    (state) => useSessionDocument(state, documentUserId, reload),
    { initialProps: session, wrapper: StrictMode }
  );
  return { ...hook, reload };
};

describe("account-specific document lifecycle", () => {
  afterEach(cleanup);

  it.each([null, user])(
    "preserves a hydrated document for the same identity: %j",
    (identity) => {
      const { reload, result } = observe(
        identity?.id ?? null,
        settled(identity)
      );
      expect(reload).not.toHaveBeenCalled();
      expect(result.current).toBeFalsy();
    }
  );

  it("reloads once after logout, without depending on any language control", () => {
    const { reload, rerender, result } = observe("u1", settled(user));
    rerender(settled(null));
    expect(reload).toHaveBeenCalledOnce();
    expect(result.current).toBeTruthy();
    rerender(settled(null));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads when another account replaces the document's account", () => {
    const { reload, rerender } = observe("u1", settled(user));
    rerender(settled({ ...user, id: "u2" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads a guest document when the user signs in", () => {
    const { reload, rerender } = observe(null, settled(null));
    rerender(settled(user));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits for the initial session instead of mistaking pending state for logout", () => {
    const { reload, rerender, result } = observe("u1", {
      ...settled(null),
      isPending: true,
    });
    expect(reload).not.toHaveBeenCalled();
    expect(result.current).toBeFalsy();
    rerender(settled(user));
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload on a network/session error", () => {
    const { reload, rerender, result } = observe("u1", settled(user));
    rerender({ ...settled(null), error: new Error("Offline") });
    expect(reload).not.toHaveBeenCalled();
    expect(result.current).toBeFalsy();
  });

  it("catches an account change between SSR and hydration without double reload in StrictMode", () => {
    const { reload } = observe("u1", settled(null));
    expect(reload).toHaveBeenCalledOnce();
  });
});
