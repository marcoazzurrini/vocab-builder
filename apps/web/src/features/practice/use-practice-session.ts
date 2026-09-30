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
import { usePracticeBlock } from "./use-practice-block";

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
  const { controller: block, state: blockState } = usePracticeBlock(
    userId,
    state.screen.status === "ready" &&
      !["caughtUp", "done"].includes(state.screen.view.phase)
  );
  // The engine has one owner. Snapshot identity rejects stale event handlers,
  // including events fired before React has rendered an action or reload.
  const sessionRef = useRef<{ session: Session; view: SessionView } | null>(
    null
  );
  const pendingFeedback = useRef<Extract<
    SessionView,
    { phase: "feedback" }
  > | null>(null);
  const rejectedPhase = useRef<SessionView["phase"] | null>(null);
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
        block.configure(settings.lang);
        if (settings.lang !== settingsRef.current.lang) {
          pendingFeedback.current = null;
          rejectedPhase.current = null;
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
          practicePolicy: () => {
            const policy = block.policy();
            // Rebuild an unaccepted teaching prompt once, even after the goal.
            // Later selections use the normal budget and the fresh snapshot.
            return rejectedPhase.current === "exposure"
              ? { ...policy, allowNew: true }
              : policy;
          },
          settings,
          snapshot,
        });
        // A save retry must not skip an explanation the learner has not dismissed.
        const view = pendingFeedback.current ?? session.view;
        // A rejected local write is not an answer boundary. Keep the fresh
        // prompt available until the learner submits it successfully.
        if (
          !rejectedPhase.current ||
          view.phase === "caughtUp" ||
          view.phase === "done"
        ) {
          block.settle(view);
        }
        rejectedPhase.current = null;
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
  }, [reloadCount, queue, transport, queryClient, userId, fail, block]);

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
      // A finished block never resumes merely because a card becomes due.
      if (newDay) {
        reload();
      }
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, [reload]);

  const view = state.screen.status === "ready" ? state.screen.view : undefined;
  const recoveryError =
    "error" in state.screen ? state.screen.error : undefined;

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
      pendingFeedback.current = null;
      rejectedPhase.current = null;
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
      block.getSnapshot().phase !== "running" ||
      state.screen.status !== "ready" ||
      current.view !== state.screen.view
    ) {
      return;
    }
    try {
      block.updateActivity(
        document.visibilityState === "visible",
        performance.now()
      );
      action(current.session);
      current.view = current.session.view;
      pendingFeedback.current =
        current.view.phase === "feedback" ? current.view : null;
      block.settle(current.view);
      dispatch({ type: "publish", view: current.view });
    } catch (error) {
      rejectedPhase.current = current.view.phase;
      fail("write", error);
    }
  };

  return {
    block,
    blockState,
    discard,
    dismissFeedback: () =>
      act((current) => {
        // After recovery, the rebuilt engine is already at the following prompt.
        if (current.view.phase === "feedback") {
          current.dismissFeedback();
        }
      }),
    exposureDone: () => act((current) => current.exposureDone()),
    loadError: recoveryError?.kind === "load" ? recoveryError.message : null,
    recovering: state.screen.status === "recovering",
    resume: () => {
      block.resume();
      if (view?.phase === "caughtUp" || view?.phase === "done") {
        reload();
      }
    },
    retry,
    start: () => {
      if (block.getSnapshot().phase === "running") {
        return;
      }
      pendingFeedback.current = null;
      rejectedPhase.current = null;
      block.start();
      reload();
    },
    submitRecall: (typed: string, effort: Effort) =>
      act((current) => current.submitRecall(typed, effort)),
    syncConflict: recoveryError?.syncConflict ?? false,
    view,
    writeError: recoveryError?.kind === "write" ? recoveryError.message : null,
  };
};
