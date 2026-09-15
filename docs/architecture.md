# Module design

The repository is organized around hidden knowledge, not file categories. A package is useful when its callers can stop coordinating its implementation details. Small export lists are a consequence, not the sole measure of a deep module.

## Ownership and dependencies

```text
apps/web
  routes/ and server/       HTTP adapters and Worker composition
  features/practice/        Session presentation and durable browser synchronization
  features/sign-in/         App-specific sign-in presentation
  shell/                    Layout and navigation

packages/spaced-repetition  Learning rules, with no framework or database dependency
packages/database          Persistence, migrations, catalogue tooling
packages/authentication    Access policy and server/client authentication facades
```

These web directories live under `apps/web/src/`. UI components and styling remain app-local. There is deliberately no UI package in this refactor.

Administrative scripts stay with their owner: `apps/web/scripts/` prepares the web app's local settings, and `packages/database/scripts/` contains the catalogue importer, its tests, and its seed JSON. These scripts run only when explicitly invoked; they are not part of application startup. Root commands provide convenient entrypoints.

Production workspace dependencies flow in one direction:

- Web consumes authentication, database, and spaced repetition.
- Authentication uses database's authentication storage adapter.
- Database uses spaced repetition to validate and schedule answers.
- Spaced repetition does not import another workspace.
- No package imports web.

All packages export TypeScript source. Vite bundles only the entrypoints required by each target. Internal relative imports are fine inside a workspace; relative imports between workspaces and imports of unexported source are not.

## Spaced repetition

The `@vocab/spaced-repetition` browser-safe entrypoint exposes:

- `createSession({ snapshot, settings, acceptAnswer, clock })`: reconstruct progress, apply the local study-day allowance, run the session, and accept durable commands.
- `Session`: its current view and guess, exposure, recall, and feedback operations.
- Settings, answer validation, view types, and a study-day boundary helper.

Callers do not build decks, instantiate FSRS, derive ratings, calculate revisions, or convert schedules into dates. Review snapshots contain domain words, opaque schedule strings, and introduction timestamps, not SQLite column names. Only the learning engine interprets a schedule.

`@vocab/spaced-repetition/server` exposes `evaluateAnswer` and `RevisionConflict`. It validates an answer against the authoritative spelling and current schedule, then produces the next schedule and audit details. Browser session transitions and server evaluation use the same private grading and scheduling primitives. Neither owns storage or network behavior.

An action computes a detached candidate state, including queue selection. The full command must validate and `acceptAnswer` must return before a single assignment publishes that state. If either rejects, phase, schedule, allowance, and statistics remain unchanged. The acceptance callback is synchronous and returns `undefined`: write to the durable local outbox, or throw without accepting the command. Network synchronization happens separately. Do not pass an async function or perform optional notifications inside this acceptance contract. Reentrant actions reject. An omitted sink is useful for ephemeral sessions; command validation still runs.

Internal phase-specific state ties the active card, feedback, or waiting date to the phase that needs it. A guess command has no rating and revision zero; a recall command carries a rating and expected revision. Existing valid command JSON keeps its field names, values, and IDs so pending answers remain replayable. Property order is not part of command identity: saved requests are parsed with the current schema before comparison, including requests written by earlier builds.

Study days use device-local calendar boundaries `[start, nextStart)`, not 24-hour arithmetic. A skipped rollover hour shifts forward by the clock gap; a repeated hour uses its earlier occurrence. Tomorrow's boundary independently uses tomorrow's calendar date and the configured hour. There is no persisted account timezone. Normalization produces a canonical answer: repeated normalization cannot further change it. Typography is ignored, while spelling and accents remain significant.

## Database

`createDatabase(binding).forUser(authenticatedUserId)` returns:

```ts
interface UserRepository {
  settings(): Promise<Settings>;
  snapshot(language: string): Promise<ReviewSnapshot>;
  recordAnswer(answer: AnswerCommand): Promise<void>;
}
```

The repository owns user filters, Drizzle queries, storage serialization, atomic answer writes, replay idempotency, and revision conflicts. It delegates learning rules to spaced repetition. It does not know HTTP headers or Worker binding names.

Authentication must happen before choosing the repository's owner. A repository is a scoped capability, not an authentication mechanism. Individual operations cannot choose a different owner. Expected-user checks on writes prevent an old tab from replaying one account's answers after another account signs in.

There is one physical schema and one immutable migration history, including Better Auth tables and application triggers. Authentication owns the requirements for its tables; database owns their physical representation and migrations. `@vocab/database/authentication` supplies the configured storage adapter without exposing Drizzle handles or schema objects to the authentication implementation. It is intentionally a framework-specific integration seam, not a universal persistence abstraction.

`@vocab/database/testing` provisions an isolated migrated D1 database for package integration tests. It is not a production API; the boundary checker prevents its use from production files. Normal application code cannot import schema or raw connection helpers.

Schema generation, seeds, and catalogue import belong here. The deployable app retains Wrangler configuration and local/remote migration commands because only the app knows which DB binding to target. Its `migrations_dir` points to this package. No migration filenames, metadata, triggers, or production binding IDs change during the refactor.

## Authentication

`@vocab/authentication/server` exposes `createAuthentication(options)` with two operations:

- `handle(request)` serves authentication HTTP routes.
- `requireUser(headers, expectedUserId?)` returns an application identity or rejects.

The module hides Better Auth configuration, allowlists, origin checks, rate limits, magic-link hashing and expiry, email delivery, and account checks. The app supplies configuration explicitly; the package never imports `cloudflare:workers`. Cookies, table names, session lifetime, and token behavior remain unchanged.

`@vocab/authentication/client` exposes `useSession`, `requestLink`, and `signOut`. It returns application identities and errors, not a Better Auth client. Its graph must not reach database or server configuration. Sign-in copy and layout belong to the consuming application.

## Browser session synchronization

`usePracticeSession(userId)` owns loading, outbox draining, retry/discard handling, study-day rollover, visibility refreshes, and next-due timers. `SessionScreen` renders its view and dispatches semantic actions. It does not interpret database responses or coordinate persistence.

Mount the screen keyed by user ID. One queue survives reloads for that mounted account. Rebuilds disable the old prompt and drain pending writes before reading a fresh snapshot. Cancelled loads cannot replace a newer mounted session.

The outbox preserves existing user-scoped localStorage keys and answer payloads. A new answer enters memory only after its localStorage write succeeds. A failed write throws back to the session without advancing it or sending the answer. Identical pending IDs are idempotent; changed payloads for an existing ID reject. An identical answer already stored by another tab is adopted without rewriting it, so waiting for this queue also waits for every answer it accepted. An answer is removed only after acknowledgement; retries reuse its ID. Conflicts require explicit confirmation before discarding pending work. Failed local storage or server writes must be visible, not silently dropped.

## Enforcement and evidence

`bun run boundaries` runs dependency-cruiser using the root `.dependency-cruiser.cjs`. That file declares architecture rules; the library owns parsing, dependency resolution, graph analysis, and reporting. There is no custom checker or separate tooling test suite.

The rules reject undeclared external dependencies, unresolved or unexported package paths, relative cross-workspace imports, reverse dependencies, implementation-library imports from web, and production imports of test helpers. Browser features can import TanStack server functions, not Worker service wiring or server-only package entrypoints. Public client entrypoints also cannot reach server implementation indirectly through shared helpers. Workspace dependency direction is enforced by explicit rules; each workspace must still declare its dependencies in `package.json`.

This check runs during lint, CI, and the Lefthook pre-push hook. It complements TypeScript and the TanStack client/server build rather than replacing them.

Dependency-cruiser 18 needs TypeScript's JavaScript compiler API, which TypeScript 7 no longer supplies. The root therefore pins TypeScript 6 for the scanner's parser and uses it to check `oxlint.config.ts` and `oxfmt.config.ts` without emitting code. Every app and package retains its explicit TypeScript 7 dependency for compilation and typechecking. The root dispatches those workspace checks after validating its tool configurations. Reevaluate the root compiler dependency when dependency-cruiser supports TypeScript 7.

Tests cover the public learning interface and scheduling parity, isolated D1 transactions and conflicts, catalogue identity preservation, authentication through its public HTTP/session facade, browser recovery, and session reloads. Add tests at the owning module before expanding an interface. Avoid exporting internal helpers merely to make a caller's orchestration easier.
