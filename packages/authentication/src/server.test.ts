import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";

import { testDatabase } from "@vocab/database/testing";

import { createAuthentication } from "./server";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
const baseURL = "http://localhost:5173";
let auth: ReturnType<typeof createAuthentication>;

const makeAuth = () =>
  createAuthentication({
    allowedEmails: "learner@example.com",
    baseURL,
    database: fixture.binding,
    emailMode: "log",
    secret: "a-local-test-secret-with-at-least-thirty-two-characters",
  });
beforeAll(async () => {
  fixture = await testDatabase();
  auth = makeAuth();
});
afterAll(async () => {
  await fixture?.close();
});

const requestLink = (email: string, origin = baseURL) =>
  auth.handle(
    new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
      body: JSON.stringify({ callbackURL: "/", email }),
      headers: {
        "Content-Type": "application/json",
        Cookie: "better-auth.session_token=untrusted",
        Origin: origin,
      },
      method: "POST",
    })
  );

describe("Better Auth on D1", () => {
  it("rejects unauthenticated access", async () => {
    await expect(auth.requireUser(new Headers())).rejects.toThrow(/Sign in/u);
  });

  it("signs in through a single-use magic link and supports sign-out", async () => {
    const logs = spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await requestLink("learner@example.com");
      expect(response.status).toBe(200);
      const line = logs.mock.calls.find(([value]) =>
        String(value).startsWith("[local sign-in]")
      )?.[0];
      expect(line).toBeDefined();
      const url = String(line).replace("[local sign-in] ", "");
      const verified = await auth.handle(new Request(url));
      expect(verified.status).toBe(302);
      const cookie = verified.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expect(cookie).toContain("session_token");
      const headers = new Headers({ cookie });
      const currentUser = await auth.requireUser(headers);
      expect(currentUser.email).toBe("learner@example.com");
      await expect(auth.requireUser(headers, "different-user")).rejects.toThrow(
        /account/u
      );
      const reused = await auth.handle(new Request(url));
      expect(reused.headers.get("location")).toMatch(/error=/u);
      const out = await auth.handle(
        new Request(`${baseURL}/api/auth/sign-out`, {
          body: "{}",
          headers: {
            "Content-Type": "application/json",
            Origin: baseURL,
            cookie,
          },
          method: "POST",
        })
      );
      expect(out.status).toBe(200);
      await expect(auth.requireUser(headers)).rejects.toThrow(/Sign in/u);
    } finally {
      logs.mockRestore();
    }
  });

  it("does not deliver links to addresses outside the allowlist", async () => {
    const logs = spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await requestLink("stranger@example.com");
      expect(response.status).toBe(200);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  });

  it("rejects an untrusted origin", async () => {
    const response = await requestLink(
      "learner@example.com",
      "https://attacker.example"
    );
    expect(response.status).toBe(403);
  });

  it("keeps email rate limits in D1 across fresh auth instances", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      // Each fresh instance must observe the previous request's persisted rate-limit count.
      // eslint-disable-next-line no-await-in-loop
      const response = await makeAuth().handle(
        new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
          body: JSON.stringify({
            callbackURL: "/",
            email: "stranger@example.com",
          }),
          headers: {
            "Content-Type": "application/json",
            Origin: baseURL,
            "cf-connecting-ip": "192.0.2.10",
          },
          method: "POST",
        })
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("fails closed when production secrets or an allowlist are absent", () => {
    expect(() => createAuthentication({ database: fixture.binding })).toThrow(
      /BETTER_AUTH/u
    );
    expect(() =>
      createAuthentication({
        baseURL: "https://vocab.example",
        database: fixture.binding,
        secret: "x".repeat(32),
      })
    ).toThrow(/ALLOWED_EMAILS/u);
  });
});
