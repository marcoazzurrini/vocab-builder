import { useQueryClient } from "@tanstack/react-query";
import {
  createSession,
  DEFAULT_SETTINGS,
  studyDayStart,
} from "@vocab/spaced-repetition";
import type { Effort, Session, Settings } from "@vocab/spaced-repetition";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { createOutbox } from "./outbox";
import { practiceKey, practiceOptions } from "./queries";
import { SyncConflict } from "./sync-conflict";
import { practiceTransport } from "./transport";
import type { PracticeTransport } from "./transport";

/** Owns a user's session, durable answers, recovery, and safe reloads. Mount keyed by user ID. */
export const usePracticeSession = (
  userId: string,
  transport: PracticeTransport = practiceTransport
) => {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  const [reloadCount, requestReload] = useReducer((n: number) => n + 1, 0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const loadedOnRef = useRef(
    studyDayStart(new Date(), DEFAULT_SETTINGS.dayRolloverHour).getTime()
  );
  const reload = useCallback(() => {
    // Invalidate before rendering cleared errors, not later in the loading effect.
    // Otherwise the old prompt briefly accepts answers that the reload can replace.
    sessionRef.current = null;
    setSession(null);
    requestReload();
  }, []);

  // One queue survives all reloads. A rebuild must read its own acknowledged writes.
  // eslint-disable-next-line react/hook-use-state -- The durable queue has immutable identity for this keyed account mount; replacing it would lose in-flight work.
  const [queue] = useState(() =>
    createOutbox({
      onError: (error) => {
        setWriteError(error.message);
        setSyncConflict(error instanceof SyncConflict);
      },
      send: async (command) => {
        await transport.persistAnswer(command, userId);
        // Mark the server snapshot stale without fetching or rebuilding an active prompt.
        await queryClient.invalidateQueries({
          queryKey: practiceKey(userId),
          refetchType: "none",
        });
      },
      storage: window.localStorage,
      userId,
    })
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // Disable the previous prompt before draining writes and fetching a new snapshot.
      // Otherwise an answer submitted during the fetch can disappear from the rebuilt session.
      sessionRef.current = null;
      setSession(null);
      try {
        await queue.settled();
        if (cancelled) {
          return;
        }
        // An older request may have started before the writes above were acknowledged.
        // Cancel it before making a fresh read, even if cached data already exists.
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
        const created = createSession({
          acceptAnswer: (answer) => {
            queue.push(answer);
          },
          settings,
          snapshot,
        });
        sessionRef.current = created;
        setSession(created);
        setLoadError(null);
        setWriteError(null);
        setSyncConflict(false);
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      void queryClient.cancelQueries({
        exact: true,
        queryKey: practiceKey(userId),
      });
    };
    // eslint-disable-next-line react/exhaustive-effect-dependencies -- The reload counter intentionally invalidates the snapshot.
  }, [reloadCount, queue, transport, queryClient, userId]);

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

  const view = session?.view;
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
    try {
      await queue.retry();
      setLoadError(null);
      setWriteError(null);
      setSyncConflict(false);
      reload();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
      setSyncConflict(error instanceof SyncConflict);
    }
  };

  /** The caller must obtain confirmation before discarding unsynchronized answers. */
  const discard = () => {
    try {
      queue.discard();
      setLoadError(null);
      setWriteError(null);
      setSyncConflict(false);
      reload();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    }
  };

  const act = (action: (current: Session) => void) => {
    const { current } = sessionRef;
    if (!current || current !== session || loadError || writeError) {
      return;
    }
    try {
      action(current);
      rerender();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
      setSyncConflict(error instanceof SyncConflict);
    }
  };

  return {
    discard,
    dismissFeedback: () => act((current) => current.dismissFeedback()),
    exposureDone: () => act((current) => current.exposureDone()),
    loadError,
    retry,
    submitGuess: (typed: string) =>
      act((current) => current.submitGuess(typed)),
    submitRecall: (typed: string, effort: Effort) =>
      act((current) => current.submitRecall(typed, effort)),
    syncConflict,
    view,
    writeError,
  };
};
