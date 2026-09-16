import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { practiceReadFetch, RetryableReadError } from "./transport";

const request = vi.fn<typeof fetch>();

describe("practice read transport", () => {
  beforeEach(() => {
    request.mockReset().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", request);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves request options and forwards cancellation", async () => {
    const controller = new AbortController();
    const headers = { "x-test": "preserved" };
    await practiceReadFetch("https://example.test/practice", {
      headers,
      signal: controller.signal,
    });
    const options = request.mock.calls[0]?.[1];
    expect(options?.headers).toStrictEqual(headers);
    expect(options?.signal?.aborted).toBeFalsy();
    controller.abort();
    expect(options?.signal?.aborted).toBeTruthy();
  });

  it("classifies a network failure as retryable", async () => {
    request.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      practiceReadFetch("https://example.test/practice")
    ).rejects.toBeInstanceOf(RetryableReadError);
  });

  it.each([408, 429, 502, 503, 504])(
    "classifies HTTP %i as retryable",
    async (status) => {
      request.mockResolvedValue(new Response("Unavailable", { status }));
      await expect(
        practiceReadFetch("https://example.test/practice")
      ).rejects.toBeInstanceOf(RetryableReadError);
    }
  );

  it.each([400, 401, 403, 500])(
    "leaves server rejection HTTP %i to Start's decoder",
    async (status) => {
      const response = new Response("Rejected", { status });
      request.mockResolvedValue(response);
      const result = await practiceReadFetch("https://example.test/practice");
      expect(result.status).toBe(status);
      await expect(result.text()).resolves.toBe("Rejected");
    }
  );

  it.each(["x-tss-serialized", "x-tss-raw"])(
    "does not classify a %s response as a transient gateway failure",
    async (header) => {
      const response = new Response("Server result", {
        headers: { [header]: "true" },
        status: 503,
      });
      request.mockResolvedValue(response);
      const result = await practiceReadFetch("https://example.test/practice");
      expect(result.status).toBe(503);
      expect(result.headers.get(header)).toBe("true");
      await expect(result.text()).resolves.toBe("Server result");
    }
  );

  it("does not retry cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    request.mockRejectedValue(controller.signal.reason);
    await expect(
      practiceReadFetch("https://example.test/practice", {
        signal: controller.signal,
      })
    ).rejects.toBe(controller.signal.reason);
  });

  it("retries a connection drop while downloading a serialized response body", async () => {
    const failure = new TypeError("Connection closed");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"words":'));
        controller.error(failure);
      },
    });
    request.mockResolvedValue(
      new Response(body, { headers: { "x-tss-serialized": "true" } })
    );
    await expect(
      practiceReadFetch("https://example.test/practice")
    ).rejects.toMatchObject({ cause: failure, name: "RetryableReadError" });
  });

  it.each(["timeout", "cancellation"] as const)(
    "classifies %s after headers while the body is still pending",
    async (reason) => {
      const controller = new AbortController();
      if (reason === "timeout") {
        vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      }
      const body = new ReadableStream({
        start(stream) {
          controller.signal.addEventListener("abort", () => {
            stream.error(controller.signal.reason);
          });
        },
      });
      request.mockResolvedValue(new Response(body));
      const download = practiceReadFetch("https://example.test/practice", {
        signal: reason === "cancellation" ? controller.signal : undefined,
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const failure = new DOMException("Download interrupted", "AbortError");
      controller.abort(failure);
      await expect(download).rejects.toBeInstanceOf(
        reason === "timeout" ? RetryableReadError : DOMException
      );
    }
  );

  it("preserves a response without a body", async () => {
    const response = new Response(null, { status: 204 });
    request.mockResolvedValue(response);
    await expect(
      practiceReadFetch("https://example.test/practice")
    ).resolves.toBe(response);
  });

  it("sets a ten-second timeout and classifies a timeout as retryable", async () => {
    const expired = AbortSignal.abort(
      new DOMException("Timed out", "TimeoutError")
    );
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(expired);
    request.mockRejectedValue(expired.reason);
    await expect(
      practiceReadFetch("https://example.test/practice")
    ).rejects.toBeInstanceOf(RetryableReadError);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});
