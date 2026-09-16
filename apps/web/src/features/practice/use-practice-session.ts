import { useQueryClient } from "@tanstack/react-query";
import {
  createSession,
  DEFAULT_SETTINGS,
  studyDayStart,
} from "@vocab/spaced-repetition";
import type {
  Effort,
  Session,
  SessionView,
  Settings,
} from "@vocab/spaced-repetition";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { createOutbox } from "./outbox";
import { practiceKey, practiceOptions } from "./queries";
import { SyncConflict } from "./sync-conflict";
import { practiceTransport } from "./transport";
import type { PracticeTransport } from "./transport";

interface PracticeError {
  kind: "load" | "write";
  message: string;
  syncConflict: boolean;
}
type ScreenState =
  | { status: "loading" }
  | { status: "ready"; view: SessionView }
  | { status: "error" | "recovering"; error: PracticeError };
interface PracticeState {
  reloadCount: number;
  screen: ScreenState;
}
type PracticeEvent =
  | { type: "load" | "reload" | "recover" }
  | { type: "loaded" | "publish"; view: SessionView }
  | { type: "fail"; error: PracticeError };

const failureEvent = (
  kind: PracticeError["kind"],
  error: Error
): PracticeEvent => ({
  error: {
    kind,
    message: error.message,
    syncConflict: error instanceof SyncConflict,
  },
  type: "fail",
});

// Only presentation lifecycle belongs here. Practice transitions and side effects
// remain in the session engine and event handlers, never in the reducer.
const reducePractice = (
  state: PracticeState,
  event: PracticeEvent
): PracticeState => {
  switch (event.type) {
    case "reload": {
      return {
        reloadCount: state.reloadCount + 1,
        screen: { status: "loading" },
      };
    }
    case "load": {
      return { ...state, screen: { status: "loading" } };
    }
    case "recover": {
      return "error" in state.screen
        ? {
            ...state,
            screen: { error: state.screen.error, status: "recovering" },
          }
        : state;
    }
    case "loaded": {
      return { ...state, screen: { status: "ready", view: event.view } };
    }
    case "publish": {
      // An asynchronous save error may be queued before React renders this action.
      // Only a successful reload can clear recovery; an action must not hide it.
      return state.screen.status === "ready"
        ? { ...state, screen: { status: "ready", view: event.view } }
        : state;
    }
    case "fail": {
      return { ...state, screen: { error: event.error, status: "error" } };
    }
    // no default
  }
};

/** Owns a user's session, durable answers, recovery, and safe reloads. Mount keyed by user ID. */
export const usePracticeSession = (
  userId: string,
  transport: PracticeTransport = practiceTransport
) => {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(reducePractice, {
    reloadCount: 0,
    screen: { status: "loading" },
  });
  // The engine has one owner. Snapshot identity rejects stale event handlers,
  // including events fired before React has rendered an action or reload.
  const sessionRef = useRef<{ session: Session; view: SessionView } | null>(
    null
  );
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const loadedOnRef = useRef(
    studyDayStart(new Date(), DEFAULT_SETTINGS.dayRolloverHour).getTime()
  );
  const reload = useCallback(() => {
    sessionRef.current = null;
    dispatch({ type: "reload" });
  }, []);
  // eslint-disable-next-line anti-slop/no-unknown-parameters -- Normalize exceptions from storage, transport, and the session at this error boundary.
  const fail = useCallback((kind: PracticeError["kind"], error: unknown) => {
    sessionRef.current = null;
    dispatch(
      failureEvent(
        kind,
        error instanceof Error ? error : new Error(String(error))
      )
    );
  }, []);

  // One queue survives all reloads. A rebuild must read its own acknowledged writes.
  // eslint-disable-next-line react/hook-use-state -- The durable queue has immutable identity for this keyed account mount; replacing it would lose in-flight work.
  const [queue] = useState(() =>
    createOutbox({
      onError: (error) => dispatch(failureEvent("write", error)),
      send: async (command) => {
        await transport.persistAnswer(command, userId);
        // Mark the server snapshot stale without fetching or rebuilding an active prompt.
        await queryClient.invalidateQueries({
          queryKey: practiceKey(userId),
          refetchType: "none",
        });
      },
      // Access can itself fail when browser storage is unavailable. Let the
      // outbox report that through recovery rather than throwing during render.
      storage: () => window.localStorage,
      userId,
    })
  );

  const { reloadCount } = state;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // Disable the previous prompt before draining writes and fetching a new snapshot.
      sessionRef.current = null;
      dispatch({ type: "load" });
      try {
        await queue.settled();
        if (cancelled) {
          return;
        }
        // An older request may have started before the writes above were acknowledged.
        await queryClient.cancelQueries({
          exact: true,
          queryKey: practiceKey(userId),
        });
        // staleTime: 0 alone can reuse future-dated cache entries after a clock change.
        await queryClient.invalidateQueries({
          exact: true,
          queryKey: practiceKey(userId),
          refetchType: "none",
        });
        if (cancelled) {
          return;
        }
        const { settings, snapshot } = await queryClient.query(
          practiceOptions(userId, transport)
        );
        if (cancelled) {
          return;
        }
        settingsRef.current = settings;
        loadedOnRef.current = studyDayStart(
          new Date(),
          settings.dayRolloverHour
        ).getTime();
        const session = createSession({
          acceptAnswer: (answer) => {
            queue.push(answer);
          },
          settings,
          snapshot,
        });
        const { view } = session;
        sessionRef.current = { session, view };
        dispatch({ type: "loaded", view });
      } catch (error) {
        if (!cancelled) {
          fail("load", error);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      sessionRef.current = null;
      void queryClient.cancelQueries({
        exact: true,
        queryKey: practiceKey(userId),
      });
    };
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- The reload counter intentionally invalidates the snapshot.
  }, [reloadCount, queue, transport, queryClient, userId, fail]);

  // This account-keyed mount owns practice reads. Drop private data on logout/account changes.
  // The durable outbox is separate and must survive unmounting.
  useEffect(
    () => () => queryClient.removeQueries({ queryKey: practiceKey(userId) }),
    [queryClient, userId]
  );

  // Local storage is the only copy until acknowledgement. Warn before leaving with pending work.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (queue.pending > 0) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);

  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const newDay =
        studyDayStart(
          new Date(),
          settingsRef.current.dayRolloverHour
        ).getTime() !== loadedOnRef.current;
      const phase = sessionRef.current?.view.phase;
      // Never replace an active prompt merely because the tab became visible.
      if (newDay || phase === "done" || phase === "caughtUp") {
        reload();
      }
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, [reload]);

  const view = state.screen.status === "ready" ? state.screen.view : undefined;
  const recoveryError =
    "error" in state.screen ? state.screen.error : undefined;
  const nextDue = view?.phase === "caughtUp" ? view.nextDueAt.getTime() : null;
  useEffect(() => {
    if (nextDue === null) {
      return;
    }
    const timer = setTimeout(
      reload,
      Math.max(1000, nextDue - Date.now() + 1000)
    );
    return () => clearTimeout(timer);
  }, [nextDue, reload]);

  const retry = async () => {
    if (state.screen.status !== "error") {
      return;
    }
    sessionRef.current = null;
    dispatch({ type: "recover" });
    try {
      await queue.retry();
      reload();
    } catch (error) {
      fail("write", error);
    }
  };

  /** The caller must obtain confirmation before discarding unsynchronized answers. */
  const discard = () => {
    if (state.screen.status !== "error") {
      return;
    }
    try {
      queue.discard();
      reload();
    } catch (error) {
      fail("write", error);
    }
  };

  const act = (action: (current: Session) => void) => {
    const { current } = sessionRef;
    if (
      !current ||
      queue.needsRecovery ||
      state.screen.status !== "ready" ||
      current.view !== state.screen.view
    ) {
      return;
    }
    try {
      action(current.session);
      current.view = current.session.view;
      dispatch({ type: "publish", view: current.view });
    } catch (error) {
      fail("write", error);
    }
  };

  return {
    discard,
    dismissFeedback: () => act((current) => current.dismissFeedback()),
    exposureDone: () => act((current) => current.exposureDone()),
    loadError: recoveryError?.kind === "load" ? recoveryError.message : null,
    recovering: state.screen.status === "recovering",
    retry,
    submitGuess: (typed: string) =>
      act((current) => current.submitGuess(typed)),
    submitRecall: (typed: string, effort: Effort) =>
      act((current) => current.submitRecall(typed, effort)),
    syncConflict: recoveryError?.syncConflict ?? false,
    view,
    writeError: recoveryError?.kind === "write" ? recoveryError.message : null,
  };
};
