import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth, authenticatedUser } from "./auth";
import { testDatabase } from "./db/testing";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const baseURL = "http://localhost:5173";
let auth: ReturnType<typeof createAuth>;

const makeAuth = () =>
  createAuth({
    DB: fixture.binding,
    BETTER_AUTH_URL: baseURL,
    BETTER_AUTH_SECRET: "a-local-test-secret-with-at-least-thirty-two-characters",
    ALLOWED_EMAILS: "learner@example.com",
    AUTH_EMAIL_MODE: "log",
  });
beforeAll(async () => {
  fixture = await testDatabase();
  auth = makeAuth();
});
afterAll(async () => {
  await fixture?.close();
});

const requestLink = (email: string, origin = baseURL) =>
  auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: "better-auth.session_token=untrusted",
      },
      body: JSON.stringify({ email, callbackURL: "/" }),
    }),
  );

describe("Better Auth on D1", () => {
  it("rejects unauthenticated access", async () => {
    await expect(authenticatedUser(auth, new Headers())).rejects.toThrow(/Sign in/);
  });

  it("signs in through a single-use magic link and supports sign-out", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect((await requestLink("learner@example.com")).status).toBe(200);
      const line = logs.mock.calls.find(([value]) =>
        String(value).startsWith("[local sign-in]"),
      )?.[0];
      expect(line).toBeDefined();
      const url = String(line).replace("[local sign-in] ", "");
      const verified = await auth.handler(new Request(url));
      expect(verified.status).toBe(302);
      const cookie = verified.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(cookie).toContain("session_token");
      const headers = new Headers({ cookie });
      expect((await authenticatedUser(auth, headers)).email).toBe("learner@example.com");
      await expect(authenticatedUser(auth, headers, "different-user")).rejects.toThrow(/account/);
      const reused = await auth.handler(new Request(url));
      expect(reused.headers.get("location")).toMatch(/error=/);
      const out = await auth.handler(
        new Request(`${baseURL}/api/auth/sign-out`, {
          method: "POST",
          headers: { cookie, Origin: baseURL, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      expect(out.status).toBe(200);
      await expect(authenticatedUser(auth, headers)).rejects.toThrow(/Sign in/);
    } finally {
      logs.mockRestore();
    }
  });

  it("does not deliver links to addresses outside the allowlist", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect((await requestLink("stranger@example.com")).status).toBe(200);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  });

  it("rejects an untrusted origin", async () => {
    const response = await requestLink("learner@example.com", "https://attacker.example");
    expect(response.status).toBe(403);
  });

  it("keeps email rate limits in D1 across fresh auth instances", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      const response = await makeAuth().handler(
        new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: baseURL,
            "cf-connecting-ip": "192.0.2.10",
          },
          body: JSON.stringify({ email: "stranger@example.com", callbackURL: "/" }),
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("fails closed when production secrets or an allowlist are absent", () => {
    expect(() => createAuth({ DB: fixture.binding })).toThrow(/BETTER_AUTH/);
    expect(() =>
      createAuth({
        DB: fixture.binding,
        BETTER_AUTH_URL: "https://vocab.example",
        BETTER_AUTH_SECRET: "x".repeat(32),
      }),
    ).toThrow(/ALLOWED_EMAILS/);
  });
});
