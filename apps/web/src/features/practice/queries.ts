import { queryOptions } from "@tanstack/react-query";

import { practiceTransport, RetryableReadError } from "./transport";
import type { PracticeTransport } from "./transport";

export const practiceKey = (userId: string) => ["practice", userId] as const;

export const practiceOptions = (
  userId: string,
  transport: PracticeTransport = practiceTransport
) =>
  queryOptions({
    // Recovery must surface offline failures instead of pausing indefinitely.
    networkMode: "always",
    queryFn: ({ signal }) => transport.loadPractice(userId, signal),
    queryKey: practiceKey(userId),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: (failures, error) =>
      failures < 2 && error instanceof RetryableReadError,
    retryDelay: (attempt) => 250 * 2 ** attempt,
    // Rebuilding a session must read its acknowledged writes, never an old cache entry.
    staleTime: 0,
  });
