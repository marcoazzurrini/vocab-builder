# Authentication

This package owns magic-link delivery, session identity, the email allowlist, and account binding. The server entrypoint uses Better Auth with the real D1 adapter. The client entrypoint exposes only the public identity and sign-in/sign-out commands.

## Access policy

`ALLOWED_EMAILS` controls ongoing app access, not only enrollment. After changed configuration reaches an authentication instance, a removed address cannot create a session, redeem an outstanding link, or pass `requireUser`. A browser session read returns 401 for that address. The rejected session is deleted and its browser cookie is cleared; a later request with the same cookie is anonymous.

Removal is enforced lazily on session reads, not by a background cleanup job. Re-adding an address does not restore deleted sessions. Requests already authorized before a configuration change can finish. Only `/sign-in/magic-link`, `/magic-link/verify`, `/get-session`, and `/sign-out` are exposed. Other Better Auth endpoints return 404. Review authorization before enabling additional endpoints or plugins.

Resend requests time out after ten seconds. Provider error details are not exposed. Allowed and disallowed addresses receive the same successful response during normal delivery, but provider failures can distinguish them by status. This is not a guarantee against email enumeration through timing or outages.

## Tests

Run from the repository root:

```sh
bun run --filter @vocab/authentication test
bun run --filter @vocab/authentication typecheck
bun run --filter @vocab/authentication test:coverage --randomize --seed 42
```

- `src/server.test.ts` exercises the actual handler and D1 migrations. One ephemeral Worker is reused, but authentication tables are cleared before each test. Each request supplies a deterministic client IP. Only external email transport, console output, and the timeout signal are stubbed.
- `src/client.test.ts` tests the client wrapper against a mocked React client. These are projection and command-contract tests, not React rendering tests. The package runs in a separate Bun process through workspace scripts; do not merge its module mocks into an application test process.
- Expiry tests change persisted timestamps rather than sleeping or assuming Bun's clock controls Workerd.
- Concurrent redemption checks authenticated sessions, not only redirect status. Database failure injection verifies that no usable session escapes, a fresh link can recover, and session-read failures remain server errors rather than appearing as anonymous sessions.
- Tests use global spies and shared Worker state. Do not enable concurrent test execution without replacing that isolation model. Concurrent requests within an individual test are intentional.

Coverage excludes database implementation and test helpers, and requires 95% lines and 100% functions. Both executable production entrypoints are imported by tests. Bun reports executed files only: when adding a production module, add tests that import it and inspect the LCOV file list. The percentage is not a branch-coverage or security-completeness claim. CI records a randomized seed and uploads `coverage/lcov.info`.

## Remaining integration work

The suite does not replace a real Worker/browser test of routing, environment bindings, cookie forwarding, login UI behavior, or protected cross-account reads and writes. Populated database upgrades through Wrangler also need their own migration tests. Keep those tests at the application/database boundaries rather than mocking those boundaries inside this package.
