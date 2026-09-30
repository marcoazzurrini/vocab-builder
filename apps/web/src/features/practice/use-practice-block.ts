import { useEffect, useState, useSyncExternalStore } from "react";

import { createPracticeBlock } from "./practice-block";

/** Count visible practice, not loading, recovery, explicit pauses, or time away. */
export const usePracticeBlock = (userId: string, canCount: boolean) => {
  // eslint-disable-next-line react/hook-use-state -- The controller has immutable identity for this account-keyed mount.
  const [controller] = useState(() =>
    createPracticeBlock(userId, () => window.localStorage)
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  useEffect(() => {
    const update = () =>
      controller.updateActivity(
        canCount &&
          state.phase === "running" &&
          document.visibilityState === "visible",
        performance.now()
      );
    const suspend = () => controller.updateActivity(false, performance.now());
    update();
    const interval = window.setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", update);
    window.addEventListener("storage", controller.sync);
    return () => {
      suspend();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", update);
      window.removeEventListener("storage", controller.sync);
    };
  }, [canCount, controller, state.phase]);
  return { controller, state };
};
