import type { SessionView } from "@vocab/spaced-repetition";
import * as v from "valibot";

const MINUTE = 60_000;
export const BLOCK_MINUTES = [3, 5, 10] as const;
const Preferences = v.object({
  minutes: v.picklist(BLOCK_MINUTES),
});
const SavedBlock = v.object({
  elapsedMs: v.pipe(v.number(), v.minValue(0), v.maxValue(10 * MINUTE)),
  phase: v.picklist(["setup", "running", "paused", "complete"]),
  preferences: Preferences,
  reason: v.nullable(v.picklist(["goal", "caughtUp", "done", "stopped"])),
  version: v.literal(1),
});
type BlockPreferences = v.InferOutput<typeof Preferences>;
type SavedBlockData = v.InferOutput<typeof SavedBlock>;
export interface BlockState extends SavedBlockData {
  storageUnavailable: boolean;
}
interface BlockStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const initialState = (): BlockState => ({
  elapsedMs: 0,
  phase: "setup",
  preferences: { minutes: 5 },
  reason: null,
  storageUnavailable: false,
  version: 1,
});

const restore = (raw: string | null): BlockState | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = v.safeParse(SavedBlock, JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    const saved = parsed.output;
    return {
      ...saved,
      elapsedMs: Math.min(saved.elapsedMs, saved.preferences.minutes * MINUTE),
      // Refreshes and other tabs never start a second clock automatically.
      phase: saved.phase === "running" ? "paused" : saved.phase,
      storageUnavailable: false,
    };
  } catch {
    return null;
  }
};

/** A device-local time goal, independent of FSRS and the durable answer outbox. */
export const createPracticeBlock = (
  userId: string,
  storage: () => BlockStorage
) => {
  let state = initialState();
  let key: string | null = null;
  let savedText: string | null = null;
  let activeSince: number | null = null;
  const listeners = new Set<() => void>();
  const goalMs = () => state.preferences.minutes * MINUTE;
  const remainingMs = () => Math.max(0, goalMs() - state.elapsedMs);

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const refresh = () => {
    if (!key) {
      return false;
    }
    const raw = storage().getItem(key);
    if (raw === savedText) {
      return false;
    }
    savedText = raw;
    const restored = restore(raw);
    if (!restored) {
      return false;
    }
    state = restored;
    activeSince = null;
    notify();
    return true;
  };
  const publish = (next: BlockState) => {
    state = next;
    if (key) {
      try {
        // Do not let a stale paused tab overwrite a newer or finished block.
        if (refresh()) {
          return;
        }
        const serialized = JSON.stringify(v.parse(SavedBlock, state));
        storage().setItem(key, serialized);
        savedText = serialized;
        state = { ...state, storageUnavailable: false };
      } catch {
        // Optional timer persistence must never discard or bypass durable answers.
        state = { ...state, storageUnavailable: true };
      }
    }
    notify();
  };

  const updateActivity = (active: boolean, now: number) => {
    const delta = activeSince === null ? 0 : Math.max(0, now - activeSince);
    activeSince = active && state.phase === "running" ? now : null;
    if (state.phase === "running" && delta > 0 && remainingMs() > 0) {
      publish({
        ...state,
        elapsedMs: Math.min(goalMs(), state.elapsedMs + delta),
      });
    }
  };

  const complete = (reason: NonNullable<SavedBlockData["reason"]>) => {
    activeSince = null;
    publish({ ...state, phase: "complete", reason });
  };

  return {
    configure: (lang: string) => {
      const nextKey = `vocab:practice-block:v1:${encodeURIComponent(userId)}:${encodeURIComponent(lang)}`;
      if (nextKey === key) {
        return;
      }
      key = nextKey;
      activeSince = null;
      savedText = null;
      state = initialState();
      try {
        savedText = storage().getItem(key);
        state = restore(savedText) ?? state;
      } catch {
        state = { ...state, storageUnavailable: true };
      }
      // Merely opening another tab must not pause the original tab's clock.
      notify();
    },
    dismiss: () => {
      activeSince = null;
      publish({ ...state, phase: "setup" });
    },
    finish: (now: number) => {
      updateActivity(false, now);
      complete("stopped");
    },
    getSnapshot: () => state,
    pause: (now: number) => {
      if (state.phase !== "running") {
        return;
      }
      updateActivity(false, now);
      if (state.phase === "running") {
        publish({ ...state, phase: "paused" });
      }
    },
    policy: () => ({
      // Reserve space for first retrieval; this is a conservative product default.
      allowNew: remainingMs() >= 90_000,
      dueOnly: true,
    }),
    resume: () => {
      if (state.phase !== "paused") {
        return;
      }
      // A pause does not remove an unfinished answer or corrective feedback.
      publish({ ...state, phase: "running" });
    },
    setMinutes: (minutes: BlockPreferences["minutes"]) => {
      if (state.phase === "setup") {
        publish({
          ...state,
          elapsedMs: 0,
          preferences: { ...state.preferences, minutes },
        });
      }
    },
    settle: (view: SessionView) => {
      if (state.phase !== "running" || view.phase === "feedback") {
        return;
      }
      if (remainingMs() === 0) {
        complete("goal");
      } else if (view.phase === "caughtUp" || view.phase === "done") {
        complete(view.phase);
      }
    },
    start: () => {
      activeSince = null;
      publish({ ...state, elapsedMs: 0, phase: "running", reason: null });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sync: () => {
      try {
        refresh();
      } catch {
        state = { ...state, storageUnavailable: true };
        notify();
      }
    },
    updateActivity,
  };
};
export type PracticeBlock = ReturnType<typeof createPracticeBlock>;
