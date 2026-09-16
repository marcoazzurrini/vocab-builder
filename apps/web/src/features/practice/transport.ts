import type { AnswerCommand } from "@vocab/spaced-repetition";

import { getPractice, recordAnswer } from "../../server/functions";
import { SyncConflict } from "./sync-conflict";

export class RetryableReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableReadError";
  }
}

/** Classify transport failures before Start deserializes server/domain errors. */
export const practiceReadFetch: typeof fetch = async (input, init) => {
  const signal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeout = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    // Leave serialized server/domain errors to Start's decoder, outside this catch.
    if (
      !response.headers.has("x-tss-serialized") &&
      !response.headers.has("x-tss-raw") &&
      [408, 429, 502, 503, 504].includes(response.status)
    ) {
      throw new RetryableReadError(
        "Servizio temporaneamente non disponibile. Riprova."
      );
    }
    if (!response.body) {
      return response;
    }
    // Bootstrap contains no deferred data. Finish downloading inside the error boundary
    // so a timeout or connection drop after headers receives the same read retries.
    const body = await response.arrayBuffer();
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    if (signal?.aborted || error instanceof RetryableReadError) {
      throw error;
    }
    throw new RetryableReadError("Caricamento non riuscito. Riprova.", {
      cause: error,
    });
  }
};

export const loadPractice = (expectedUserId: string, signal: AbortSignal) =>
  getPractice({
    data: { expectedUserId },
    fetch: practiceReadFetch,
    signal,
  });

export const persistAnswer = async (
  command: AnswerCommand,
  expectedUserId: string
) => {
  const result = await recordAnswer({
    data: { answer: command, expectedUserId },
  });
  if (result.conflict) {
    throw new SyncConflict();
  }
};

export const practiceTransport = { loadPractice, persistAnswer };
export type PracticeTransport = typeof practiceTransport;
