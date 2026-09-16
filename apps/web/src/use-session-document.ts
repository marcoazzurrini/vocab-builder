import type { SessionState } from "@vocab/authentication/client";
import { useEffect, useRef } from "react";

const reloadDocument = () => globalThis.location.reload();

/** Reload account-specific HTML and caches after a resolved identity change. */
export const useSessionDocument = (
  session: SessionState,
  documentUserId: string | null,
  reload: () => void = reloadDocument
): boolean => {
  const reloadStarted = useRef(false);
  const identityChanged =
    !session.isPending &&
    !session.error &&
    (session.user?.id ?? null) !== documentUserId;

  useEffect(() => {
    if (identityChanged && !reloadStarted.current) {
      reloadStarted.current = true;
      reload();
    }
  }, [identityChanged, reload]);

  return identityChanged;
};
