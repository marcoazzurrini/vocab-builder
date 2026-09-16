import type { I18n } from "@lingui/core";
import { resolveLocale } from "@vocab/i18n/locales";
import { describe, expect, it, vi } from "vitest";

import { startInstance } from "../start";
import type { LanguageResolver } from "./language";
import { createLanguageMiddleware, languageMiddleware } from "./language";

interface RequestContext {
  i18n?: I18n;
  userId?: string | null;
}

// Exercise the registered middleware, including Start's real CSRF protection.
// Inject only language resolution; request classification, catalog loading,
// request-local instances, and response headers use the production code.
const request = async (
  handlerType: "router" | "serverFn",
  path = "/",
  headers: HeadersInit = {},
  method = "GET",
  resolve: LanguageResolver = (incoming) =>
    Promise.resolve({
      locale: resolveLocale({
        acceptLanguage: incoming.get("accept-language"),
        user: null,
      }),
      userId: null,
    })
) => {
  const incoming = new Request(`http://localhost${path}`, { headers, method });
  const resolveLanguage = vi.fn<LanguageResolver>(resolve);
  const options = await startInstance.getOptions();
  const middleware = options.requestMiddleware?.map((entry) =>
    entry === languageMiddleware
      ? createLanguageMiddleware(resolveLanguage)
      : entry
  );
  let completed = false;
  const dispatch = (
    index: number,
    context: RequestContext
  ): Promise<
    | Response
    | {
        context?: RequestContext;
        pathname: string;
        request: Request;
        response: Response;
      }
  > => {
    const server = middleware?.[index]?.options.server;
    if (!server) {
      completed = true;
      return Promise.resolve({
        context,
        pathname: path,
        request: incoming,
        response: new Response("ok"),
      });
    }
    const next = async ({
      context: added,
    }: { context?: RequestContext } = {}) => {
      const result = await dispatch(index + 1, { ...context, ...added });
      return result instanceof Response
        ? {
            context: { ...context, ...added },
            pathname: path,
            request: incoming,
            response: result,
          }
        : { ...result, context: { ...context, ...added, ...result.context } };
    };
    return Promise.resolve(
      server({
        context: undefined,
        handlerType,
        // SAFETY: Start's generic next accepts arbitrary context. This adapter
        // only receives RequestContext from the registered language middleware,
        // merges it above, and preserves the response and request metadata.
        next: next as Parameters<typeof server>[0]["next"],
        pathname: path,
        request: incoming,
      })
    );
  };
  const result = await dispatch(0, {});
  return {
    completed,
    context: result instanceof Response ? {} : (result.context ?? {}),
    resolveLanguage,
    response: result instanceof Response ? result : result.response,
  };
};

describe("Start request boundaries", () => {
  it.each(["GET", "POST"])(
    "rejects cross-site %s server functions before language resolution",
    async (method) => {
      const result = await request(
        "serverFn",
        "/_serverFn/example",
        { Origin: "https://attacker.example" },
        method
      );
      expect(result.response.status).toBe(403);
      expect(result.completed).toBeFalsy();
      expect(result.resolveLanguage).not.toHaveBeenCalled();
    }
  );

  it.each(["GET", "POST"])(
    "passes same-origin %s server functions without language setup",
    async (method) => {
      const result = await request(
        "serverFn",
        "/_serverFn/example",
        { Origin: "http://localhost" },
        method
      );
      expect(result.response.status).toBe(200);
      expect(result.completed).toBeTruthy();
      expect(result.resolveLanguage).not.toHaveBeenCalled();
      expect(result.context).not.toHaveProperty("i18n");
    }
  );

  it("leaves API requests to their own authentication and CSRF protection", async () => {
    const result = await request("router", "/api/auth/get-session");
    expect(result.completed).toBeTruthy();
    expect(result.resolveLanguage).not.toHaveBeenCalled();
    expect(result.response.headers.get("Content-Language")).toBeNull();
  });

  it("renders guest pages in the browser language without requiring an Origin", async () => {
    const result = await request("router", "/", {
      "Accept-Language": "it-IT,en;q=0.8",
    });
    expect(result.response.headers.get("Content-Language")).toBe("it");
    expect(result.response.headers.get("Cache-Control")).toBe(
      "private, no-store"
    );
    expect(result.resolveLanguage).toHaveBeenCalledOnce();
    expect(result.context.userId).toBeNull();
    expect(result.context.i18n?.locale).toBe("it");
  });

  it("renders the resolved account language and transfers its identity", async () => {
    const result = await request(
      "router",
      "/",
      { "Accept-Language": "en" },
      "GET",
      () => Promise.resolve({ locale: "it", userId: "u1" })
    );
    expect(result.response.headers.get("Content-Language")).toBe("it");
    expect(result.resolveLanguage).toHaveBeenCalledOnce();
    expect(result.context.userId).toBe("u1");
    expect(result.context.i18n?.locale).toBe("it");
  });

  it("isolates language state across concurrent page requests", async () => {
    const [italian, english] = await Promise.all([
      request("router", "/", { "Accept-Language": "it" }),
      request("router", "/", { "Accept-Language": "en" }),
    ]);
    expect(italian.context.i18n?.locale).toBe("it");
    expect(english.context.i18n?.locale).toBe("en");
    expect(italian.context.i18n).not.toBe(english.context.i18n);
  });

  it("does not hide unexpected authentication or database failures", async () => {
    await expect(
      request("router", "/", {}, "GET", () =>
        Promise.reject(new Error("Database unavailable"))
      )
    ).rejects.toThrow("Database unavailable");
  });
});
