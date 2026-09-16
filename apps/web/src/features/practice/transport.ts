import type { AnswerCommand } from "@vocab/spaced-repetition";

import { getPractice, recordAnswer } from "../../server/functions";
import { SyncConflict } from "./sync-conflict";

export class RetryableReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableReadError";
  }
}

const requestSignal = (input: RequestInfo | URL, init?: RequestInit) =>
  init?.signal ?? (input instanceof Request ? input.signal : undefined);

/** These endpoints have no deferred data; the timeout covers the whole response. */
const fetchComplete: typeof fetch = async (input, init) => {
  const signal = requestSignal(input, init);
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(input, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.body) {
    return response;
  }
  const body = await response.arrayBuffer();
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};

/** Classify transport failures before Start deserializes server/domain errors. */
export const practiceReadFetch: typeof fetch = async (input, init) => {
  try {
    const response = await fetchComplete(input, init);
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
    return response;
  } catch (error) {
    if (
      requestSignal(input, init)?.aborted ||
      error instanceof RetryableReadError
    ) {
      throw error;
    }
    throw new RetryableReadError("Caricamento non riuscito. Riprova.", {
      cause: error,
    });
  }
};

/** A timeout is not proof of rejection. The outbox retains the ID for manual retry. */
export const practiceWriteFetch: typeof fetch = async (input, init) => {
  try {
    return await fetchComplete(input, init);
  } catch (error) {
    if (requestSignal(input, init)?.aborted) {
      throw error;
    }
    throw new Error(
      "Salvataggio non riuscito. La risposta è conservata; riprova.",
      { cause: error }
    );
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
    fetch: practiceWriteFetch,
  });
  if (result.conflict) {
    throw new SyncConflict();
  }
};

export const practiceTransport = { loadPractice, persistAnswer };
export type PracticeTransport = typeof practiceTransport;
