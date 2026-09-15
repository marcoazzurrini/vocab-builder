import { useEffect, useReducer, useRef, useState } from "react";
import { createSession, DEFAULT_SETTINGS, studyDayStart } from "@vocab/spaced-repetition";
import type { Effort, Session, Settings } from "@vocab/spaced-repetition";
import { loadSettings, loadSnapshot, persistAnswer } from "./transport";
import { createOutbox } from "./outbox";
import { SyncConflict } from "./sync-conflict";

/** Owns a user's session, durable answers, recovery, and safe reloads. Mount keyed by user ID. */
export function usePracticeSession(userId: string) {
  const [session, setSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState(false);
  const [reloadCount, reload] = useReducer((n: number) => n + 1, 0);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const loadedOnRef = useRef(studyDayStart(new Date(), DEFAULT_SETTINGS.dayRolloverHour).getTime());

  // One queue survives all reloads. A rebuild must read its own acknowledged writes.
  const queueRef = useRef<ReturnType<typeof createOutbox> | null>(null);
  queueRef.current ??= createOutbox({
    userId,
    storage: window.localStorage,
    send: (command) => persistAnswer(command, userId),
    onError: (error) => {
      setWriteError(error.message);
      setSyncConflict(error instanceof SyncConflict);
    },
  });
  const queue = queueRef.current;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Disable the previous prompt before draining writes and fetching a new snapshot.
      // Otherwise an answer submitted during the fetch can disappear from the rebuilt session.
      sessionRef.current = null;
      setSession(null);
      try {
        await queue.settled();
        if (cancelled) return;
        const settings = await loadSettings();
        if (cancelled) return;
        const snapshot = await loadSnapshot(settings.lang);
        if (cancelled) return;
        settingsRef.current = settings;
        loadedOnRef.current = studyDayStart(new Date(), settings.dayRolloverHour).getTime();
        const created = createSession({
          snapshot,
          settings,
          acceptAnswer: (answer) => {
            queue.push(answer);
          },
        });
        sessionRef.current = created;
        setSession(created);
        setLoadError(null);
        setWriteError(null);
        setSyncConflict(false);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadCount, queue]);

  // Local storage is the only copy until acknowledgement. Warn before leaving with pending work.
  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (queue.pending > 0) event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);

  useEffect(() => {
    function recheck() {
      if (document.visibilityState !== "visible") return;
      const newDay =
        studyDayStart(new Date(), settingsRef.current.dayRolloverHour).getTime() !==
        loadedOnRef.current;
      const phase = sessionRef.current?.view.phase;
      // Never replace an active prompt merely because the tab became visible.
      if (newDay || phase === "done" || phase === "caughtUp") reload();
    }
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, []);

  const view = session?.view;
  const nextDue = view?.phase === "caughtUp" ? view.nextDueAt.getTime() : null;
  useEffect(() => {
    if (nextDue === null) return;
    const timer = setTimeout(reload, Math.max(1000, nextDue - Date.now() + 1000));
    return () => clearTimeout(timer);
  }, [nextDue]);

  async function retry() {
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
  }

  /** The caller must obtain confirmation before discarding unsynchronized answers. */
  function discard() {
    try {
      queue.discard();
      setLoadError(null);
      setWriteError(null);
      setSyncConflict(false);
      reload();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    }
  }

  function act(action: (current: Session) => void) {
    if (!session || loadError || writeError) return;
    try {
      action(session);
      rerender();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
      setSyncConflict(error instanceof SyncConflict);
    }
  }

  return {
    view,
    loadError,
    writeError,
    syncConflict,
    retry,
    discard,
    submitGuess: (typed: string) => act((current) => current.submitGuess(typed)),
    exposureDone: () => act((current) => current.exposureDone()),
    submitRecall: (typed: string, effort: Effort) =>
      act((current) => current.submitRecall(typed, effort)),
    dismissFeedback: () => act((current) => current.dismissFeedback()),
  };
}
