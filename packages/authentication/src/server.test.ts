import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";

import { testDatabase } from "@vocab/database/testing";

import { createAuthentication } from "./server";
import type { Authentication, AuthenticationOptions } from "./server";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const baseURL = "http://localhost:5173";
const email = "learner@example.com";
const secret = "a-local-test-secret-with-at-least-thirty-two-characters";
let auth: Authentication;
let logs: ReturnType<typeof spyOn<typeof console, "info">>;
let errors: ReturnType<typeof spyOn<typeof console, "error">>;

const makeAuth = (overrides: Partial<AuthenticationOptions> = {}) =>
  createAuthentication({
    allowedEmails: email,
    baseURL,
    database: fixture.binding,
    emailMode: "log",
    secret,
    ...overrides,
  });

beforeAll(async () => {
  fixture = await testDatabase();
});
beforeEach(async () => {
  // Reuse the Worker, not authentication state. Persistence tests share state only within a test.
  await fixture.binding.batch(
    ["session", "account", "verification", "rate_limit", "user"].map((table) =>
      fixture.binding.prepare(`DELETE FROM ${table}`)
    )
  );
  logs = spyOn(console, "info").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  auth = makeAuth();
});
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await fixture?.close();
});

const requestLink = (
  instance = auth,
  body: Record<string, string> = {},
  headers: Record<string, string> = {},
  origin = baseURL
) =>
  instance.handle(
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      body: JSON.stringify({ callbackURL: "/", email, ...body }),
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "cf-connecting-ip": "192.0.2.10",
        ...headers,
      },
      method: "POST",
    })
  );

const deliveredLink = async (instance = auth) => {
  const offset = logs.mock.calls.length;
  const response = await requestLink(instance);
  expect(response.status).toBe(200);
  const line = logs.mock.calls
    .slice(offset)
    .find(([value]) => String(value).startsWith("[local sign-in] "))?.[0];
  expect(line).toBeDefined();
  return new URL(String(line).replace("[local sign-in] ", ""));
};

const verify = (url: URL, instance = auth, ip = "192.0.2.20") =>
  instance.handle(new Request(url, { headers: { "cf-connecting-ip": ip } }));
const cookies = (response: Response) =>
  new Headers({
    Cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  });
const count = async (table: "session" | "user" | "verification") => {
  const row = await fixture.binding
    .prepare(`SELECT count(*) AS total FROM ${table}`)
    .first<{ total: number }>();
  return row?.total;
};
const signIn = async () => {
  const url = await deliveredLink();
  const response = await verify(url);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(`${baseURL}/`);
  return { headers: cookies(response), response, url };
};
const expectInvalidLink = async (url: URL) => {
  const response = await verify(url);
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    `${baseURL}/?error=INVALID_TOKEN`
  );
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await count("session")).toBe(0);
  expect(await count("user")).toBe(0);
};

describe("configuration", () => {
  it.each([
    { baseURL: undefined },
    { secret: undefined },
    { secret: "x".repeat(31) },
  ])("rejects missing or weak credentials: %j", (options) => {
    expect(() => makeAuth(options)).toThrow(/BETTER_AUTH/u);
  });
  it.each([undefined, "", " , , "])(
    "rejects empty allowlist: %j",
    (allowedEmails) => {
      expect(() => makeAuth({ allowedEmails })).toThrow(/ALLOWED_EMAILS/u);
    }
  );
  it("rejects malformed URLs and remote HTTP", () => {
    expect(() => makeAuth({ baseURL: "not-a-url" })).toThrow();
    expect(() => makeAuth({ baseURL: "http://vocab.example" })).toThrow(
      /HTTPS/u
    );
  });
  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "accepts local HTTP on %s and a 32-character secret",
    (host) => {
      expect(() =>
        makeAuth({ baseURL: `http://${host}:5173`, secret: "x".repeat(32) })
      ).not.toThrow();
    }
  );
  it("normalizes and deduplicates allowlist entries", async () => {
    const instance = makeAuth({
      allowedEmails: " LEARNER@example.com, ,learner@example.com ",
    });
    const response = await verify(await deliveredLink(instance), instance);
    const identity = await instance.requireUser(cookies(response));
    expect(identity.email).toBe(email);
  });
});

describe("sessions and access policy on D1", () => {
  it.each(["", "better-auth.session_token=untrusted"])(
    "rejects absent or invalid cookies: %j",
    async (cookie) => {
      await expect(auth.requireUser(new Headers({ cookie }))).rejects.toThrow(
        /Sign in/u
      );
    }
  );
  it("signs in, projects identity, enforces account binding, and signs out", async () => {
    const { headers, url } = await signIn();
    const identity = await auth.requireUser(headers);
    expect(identity).toEqual({ email, id: expect.any(String), name: "" });
    await expect(makeAuth().requireUser(headers, identity.id)).resolves.toEqual(
      identity
    );
    await expect(auth.requireUser(headers, "another-user")).rejects.toThrow(
      /account/u
    );
    const reused = await verify(url);
    expect(reused.headers.get("location")).toBe(
      `${baseURL}/?error=INVALID_TOKEN`
    );
    expect(reused.headers.getSetCookie()).toEqual([]);
    expect(await count("session")).toBe(1);
    const out = await auth.handle(
      new Request(`${baseURL}/api/auth/sign-out`, {
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          Cookie: headers.get("cookie") ?? "",
          Origin: baseURL,
          "cf-connecting-ip": "192.0.2.10",
        },
        method: "POST",
      })
    );
    expect(out.status).toBe(200);
    expect(
      out.headers
        .getSetCookie()
        .some(
          (value) =>
            value.includes("session_token=;") && value.includes("Max-Age=0")
        )
    ).toBe(true);
    expect(await count("session")).toBe(0);
    await expect(auth.requireUser(headers)).rejects.toThrow(/Sign in/u);
  });
  it.each(["expired", "deleted", "tampered"])(
    "rejects a %s session",
    async (mode) => {
      const { headers } = await signIn();
      if (mode === "expired") {
        await fixture.binding
          .prepare("UPDATE session SET expires_at = ?")
          .bind(Date.now() - 1000)
          .run();
      } else if (mode === "deleted") {
        await fixture.binding.prepare("DELETE FROM session").run();
      } else {
        headers.set("cookie", `${headers.get("cookie")}tampered`);
      }
      await expect(makeAuth().requireUser(headers)).rejects.toThrow(/Sign in/u);
    }
  );
  it("treats revoked access as anonymous for page rendering without authorizing progress", async () => {
    const { headers } = await signIn();
    const restricted = makeAuth({ allowedEmails: "other@example.com" });
    await expect(restricted.getUser(headers)).resolves.toBeNull();
    expect(await count("session")).toBe(0);
    await expect(restricted.requireUser(headers)).rejects.toThrow(/Sign in/u);
  });
  it.each(["server", "browser"])(
    "denies removed users through %s session reads and deletes the session",
    async (reader) => {
      const { headers } = await signIn();
      const restricted = makeAuth({ allowedEmails: "other@example.com" });
      if (reader === "server") {
        await expect(restricted.requireUser(headers)).rejects.toThrow(
          /Sign in/u
        );
      } else {
        headers.set("cf-connecting-ip", "192.0.2.10");
        const response = await restricted.handle(
          new Request(`${baseURL}/api/auth/get-session`, { headers })
        );
        expect(response.status).toBe(401);
        expect(
          response.headers
            .getSetCookie()
            .some(
              (value) =>
                value.includes("session_token=;") && value.includes("Max-Age=0")
            )
        ).toBe(true);
        expect(await response.json()).toMatchObject({
          message: "Sign in before accessing your progress.",
        });
      }
      expect(await count("session")).toBe(0);
    }
  );
  it.each([false, true])(
    "rejects outstanding links after removal (existing user: %s)",
    async (existing) => {
      if (existing) {
        await signIn();
        await fixture.binding.prepare("DELETE FROM session").run();
      }
      const url = await deliveredLink();
      const restricted = makeAuth({ allowedEmails: "other@example.com" });
      const response = await verify(url, restricted);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.status).not.toBe(200);
      expect(await count("session")).toBe(0);
      expect(await count("user")).toBe(existing ? 1 : 0);
      await expect(restricted.requireUser(cookies(response))).rejects.toThrow(
        /Sign in/u
      );
    }
  );
  it("preserves server errors when D1 cannot read sessions", async () => {
    const { headers } = await signIn();
    headers.set("cf-connecting-ip", "192.0.2.10");
    await fixture.binding
      .prepare("ALTER TABLE session RENAME TO unavailable_session")
      .run();
    try {
      await expect(makeAuth().requireUser(headers)).rejects.toThrow(
        /Failed to get session/u
      );
      const response = await makeAuth().handle(
        new Request(`${baseURL}/api/auth/get-session`, { headers })
      );
      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally {
      await fixture.binding
        .prepare("ALTER TABLE unavailable_session RENAME TO session")
        .run();
    }
    const identity = await makeAuth().requireUser(headers);
    expect(identity.email).toBe(email);
  });
  it("clears expired browser cookies without a server error", async () => {
    const { headers } = await signIn();
    headers.set("cf-connecting-ip", "192.0.2.10");
    await fixture.binding
      .prepare("UPDATE session SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    const response = await auth.handle(
      new Request(`${baseURL}/api/auth/get-session`, { headers })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(
      response.headers
        .getSetCookie()
        .some(
          (value) =>
            value.includes("session_token=;") && value.includes("Max-Age=0")
        )
    ).toBe(true);
  });
  it.each([false, true])(
    "does not expose unused authenticated endpoints (removed user: %s)",
    async (removed) => {
      const { headers } = await signIn();
      const instance = removed
        ? makeAuth({ allowedEmails: "other@example.com" })
        : auth;
      headers.set("cf-connecting-ip", "192.0.2.10");
      const listed = await instance.handle(
        new Request(`${baseURL}/api/auth/list-sessions`, { headers })
      );
      expect(listed.status).toBe(404);
      headers.set("Content-Type", "application/json");
      headers.set("Origin", baseURL);
      const updated = await instance.handle(
        new Request(`${baseURL}/api/auth/update-user`, {
          body: JSON.stringify({ name: "Changed" }),
          headers,
          method: "POST",
        })
      );
      expect(updated.status).toBe(404);
      const user = await fixture.binding
        .prepare("SELECT name FROM user")
        .first<{ name: string }>();
      expect(user?.name).toBe("");
    }
  );
  it("fails closed when session insertion fails", async () => {
    const url = await deliveredLink();
    await fixture.binding
      .prepare(
        "CREATE TRIGGER reject_auth_session BEFORE INSERT ON session BEGIN SELECT RAISE(ABORT, 'injected_failure'); END"
      )
      .run();
    try {
      const response = await verify(url);
      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await count("session")).toBe(0);
    } finally {
      await fixture.binding.prepare("DROP TRIGGER reject_auth_session").run();
    }
    // A failed creation consumes the link; a fresh link can recover without duplicate users.
    await verify(await deliveredLink());
    expect(await count("user")).toBe(1);
    expect(await count("session")).toBe(1);
  });
});

describe("magic-link security", () => {
  it("stores only the token hash with a ten-minute expiry and consumes it", async () => {
    const start = Date.now();
    const url = await deliveredLink();
    const token = url.searchParams.get("token");
    expect(token).toBeTruthy();
    const row = await fixture.binding
      .prepare("SELECT identifier, value, expires_at FROM verification")
      .first<{ identifier: string; value: string; expires_at: number }>();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(token ?? "missing");
    expect(row?.expires_at).toBeGreaterThanOrEqual(start + 600_000);
    expect(row?.expires_at).toBeLessThanOrEqual(Date.now() + 600_000);
    await verify(url);
    expect(await count("verification")).toBe(0);
  });
  it.each(["expired", "unknown", "modified"])(
    "rejects a %s token without creating an account or session",
    async (mode) => {
      const url = await deliveredLink();
      if (mode === "expired") {
        await fixture.binding
          .prepare("UPDATE verification SET expires_at = ?")
          .bind(Date.now() - 1000)
          .run();
      } else {
        url.searchParams.set(
          "token",
          mode === "unknown" ? "unknown" : `${url.searchParams.get("token")}x`
        );
      }
      await expectInvalidLink(url);
    }
  );
  it("rejects a missing token", async () => {
    const url = await deliveredLink();
    url.searchParams.delete("token");
    const response = await verify(url);
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await count("session")).toBe(0);
  });
  it("creates exactly one usable session during concurrent redemption", async () => {
    const url = await deliveredLink();
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        verify(url, makeAuth(), `192.0.2.${30 + index}`)
      )
    );
    const accepted = await Promise.all(
      responses.map(async (response) => {
        try {
          await auth.requireUser(cookies(response));
          return true;
        } catch {
          return false;
        }
      })
    );
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await count("session")).toBe(1);
    expect(await count("user")).toBe(1);
    expect(await count("verification")).toBe(0);
  });
  it.each(["https://attacker.example/", "//attacker.example/"])(
    "rejects external callback %s on redemption",
    async (callbackURL) => {
      const url = await deliveredLink();
      url.searchParams.set("callbackURL", callbackURL);
      const response = await verify(url);
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await count("session")).toBe(0);
    }
  );
  it.each([false, true])(
    "rejects untrusted origins (cookie present: %s)",
    async (withCookie) => {
      const response = withCookie
        ? await requestLink(
            auth,
            { email },
            {
              Cookie: "better-auth.session_token=untrusted",
              Origin: "https://attacker.example",
            }
          )
        : await requestLink(
            auth,
            { email },
            { Origin: "https://attacker.example" }
          );
      expect(response.status).toBe(403);
      expect(logs).not.toHaveBeenCalled();
      expect(await count("verification")).toBe(0);
    }
  );
  it("rejects cookie-free cross-site browser requests without Origin", async () => {
    const response = await auth.handle(
      new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
        body: JSON.stringify({ email }),
        headers: {
          "Content-Type": "application/json",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "cross-site",
          "cf-connecting-ip": "192.0.2.10",
        },
        method: "POST",
      })
    );
    expect(response.status).toBe(403);
    expect(logs).not.toHaveBeenCalled();
  });
  it("rejects cross-origin sign-out without deleting the session", async () => {
    const { headers } = await signIn();
    headers.set("Origin", "https://attacker.example");
    headers.set("Content-Type", "application/json");
    headers.set("cf-connecting-ip", "192.0.2.10");
    const response = await auth.handle(
      new Request(`${baseURL}/api/auth/sign-out`, {
        body: "{}",
        headers,
        method: "POST",
      })
    );
    expect(response.status).toBe(403);
    const identity = await auth.requireUser(headers);
    expect(identity.email).toBe(email);
  });
});

describe("delivery and production cookies", () => {
  const productionURL = "https://vocab.example";
  const production = (overrides: Partial<AuthenticationOptions> = {}) =>
    makeAuth({
      baseURL: productionURL,
      emailFrom: "Vocabulary <login@vocab.example>",
      emailMode: "resend",
      resendAPIKey: "test-resend-key",
      ...overrides,
    });
  it("sends the correct email, keeps responses generic, and uses secure cookies", async () => {
    const send = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );
    const instance = production();
    const response = await requestLink(
      instance,
      { callbackURL: "/practice", email },
      {},
      productionURL
    );
    const denied = await requestLink(
      instance,
      { email: "stranger@example.com" },
      {},
      productionURL
    );
    expect(response.status).toBe(200);
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual(await response.json());
    expect(send).toHaveBeenCalledTimes(1);
    const [endpoint, init] = send.mock.calls[0] ?? [];
    expect(endpoint).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer test-resend-key",
      "Content-Type": "application/json",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      from: "Vocabulary <login@vocab.example>",
      subject: "Accedi a vocab-builder",
      to: [email],
    });
    expect(body.text).toContain("Scade tra 10 minuti.");
    const url = new URL(String(body.text).split("\n\n")[1] ?? "");
    expect(url.origin).toBe(productionURL);
    expect(url.searchParams.get("callbackURL")).toBe("/practice");
    const verified = await verify(url, instance);
    expect(verified.headers.get("location")).toBe(`${productionURL}/practice`);
    const cookie = verified.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-better-auth.session_token="));
    expect(cookie).toBeDefined();
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
      expect(cookie).toContain(attribute);
    }
    const identity = await instance.requireUser(cookies(verified));
    expect(identity.email).toBe(email);
    expect(logs).not.toHaveBeenCalled();
  });
  it.each(["http", "network", "timeout"])(
    "fails safely on provider %s failure",
    async (mode) => {
      const controller = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
        controller.signal
      );
      const send = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          (
            _input: RequestInfo | URL,
            init?: RequestInit
          ): Promise<Response> => {
            if (mode === "http") {
              return Promise.resolve(
                new Response("secret-provider-body", { status: 503 })
              );
            }
            if (mode === "network") {
              return Promise.reject(new Error("secret-provider-body"));
            }
            // Simulate a pending transport that rejects only when its signal aborts.
            // eslint-disable-next-line promise/avoid-new
            return new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(new Error("secret-provider-body")),
                { once: true }
              );
              controller.abort();
            });
          },
          { preconnect: globalThis.fetch.preconnect }
        )
      );
      const response = await requestLink(
        production(),
        { email },
        {},
        productionURL
      );
      expect(response.status).toBe(500);
      expect(timeout).toHaveBeenCalledWith(10_000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await response.text()).not.toContain("secret-provider-body");
      const output = [...logs.mock.calls, ...errors.mock.calls]
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(output).not.toContain("test-resend-key");
      expect(output).not.toContain("secret-provider-body");
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await count("session")).toBe(0);
    }
  );
  it.each([{ resendAPIKey: undefined }, { emailFrom: undefined }])(
    "rejects missing provider configuration: %j",
    async (options) => {
      const send = spyOn(globalThis, "fetch").mockRejectedValue(
        new Error("Must not send")
      );
      const response = await requestLink(
        production(options),
        { email },
        {},
        productionURL
      );
      expect(response.status).toBe(500);
      expect(send).not.toHaveBeenCalled();
    }
  );
  it.each([false, true])(
    "never logs links from non-local requests (local configuration: %s)",
    async (localConfig) => {
      const instance = makeAuth({
        baseURL: localConfig ? baseURL : productionURL,
      });
      const response = await requestLink(
        instance,
        { email },
        { Origin: localConfig ? baseURL : productionURL },
        productionURL
      );
      expect(response.status).toBe(500);
      expect(logs).not.toHaveBeenCalled();
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  );
});

describe("persisted rate limiting", () => {
  it("limits delivery across instances, isolates IPs, and permits requests after the window", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      // The next request must observe the previous persisted count.
      // eslint-disable-next-line no-await-in-loop
      const response = await requestLink(makeAuth());
      statuses.push(response.status);
      if (index === 3) {
        expect(Number(response.headers.get("x-retry-after"))).toBeGreaterThan(
          0
        );
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(logs).toHaveBeenCalledTimes(3);
    const otherIP = await requestLink(
      makeAuth(),
      { email },
      { "cf-connecting-ip": "192.0.2.11" }
    );
    expect(otherIP.status).toBe(200);
    await fixture.binding
      .prepare("UPDATE rate_limit SET last_request = ?")
      .bind(Date.now() - 61_000)
      .run();
    const afterWindow = await requestLink(makeAuth());
    expect(afterWindow.status).toBe(200);
    expect(logs).toHaveBeenCalledTimes(5);
  });
});
