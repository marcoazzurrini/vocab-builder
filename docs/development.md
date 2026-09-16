# Development and deployment

## Toolchain and ownership

Use Bun 1.4.2 and Node.js 24 or newer. `packageManager` in the root `package.json` pins Bun; GitHub Actions uses the same version. Commit only `bun.lock`, not npm, pnpm, or Yarn lockfiles. Install with `bun install --frozen-lockfile` in CI.

Bun handles dependency installation, workspace commands, and administrative scripts. Vite, Vitest, and Wrangler still run with their Node shebangs; do not force `--bun` onto those tools without testing their compatibility. Production runs on Cloudflare's `workerd`, not Bun or Node. No active Deno toolchain remains.

- `apps/web` (`@vocab/web`) owns routes, HTTP adapters, Worker bindings, React UI, assets, browser answer recovery, and local settings setup. UI stays app-local; there is no UI package.
- `packages/spaced-repetition` owns session flow, grading, scheduling, answer validation, and deck reconstruction. Its public entrypoints hide FSRS machinery.
- `packages/database` owns D1 access, user-scoped repositories, Drizzle schema, migrations, catalogue seed/import, and the authentication storage adapter.
- `packages/authentication` owns Better Auth configuration, access policy, email delivery, session checks, and separate server/client facades.
- `packages/i18n` owns English and Italian UI catalogs, locale negotiation, and the Lingui runtime. See [the translation workflow](../packages/i18n/README.md).
- Each workspace declares its dependencies and explicit TypeScript source exports. Vite bundles those exports without library build steps. No relative imports between workspaces or imports of another package's internal source are allowed.
- Root configuration covers formatting, linting, Git hooks, and strict TypeScript defaults. `.dependency-cruiser.cjs` defines repository-wide import rules. `bun run boundaries` runs them during lint, CI, and the pre-push hook. See [architecture](architecture.md) for the public contracts and dependency graph.

Bun filters run workspace scripts in their workspace directory. Root `db:seed` and `setup:local` invoke scripts in their owning workspaces directly: their file arguments are relative to the repository root. Catalogue import and its seed data live in `packages/database/scripts/`; local settings setup lives in `apps/web/scripts/`. Prefer absolute paths for backups. Root commands provide common operations without requiring `cd`.

Workspace typechecks use TypeScript 7. The root's TypeScript 6 dependency provides dependency-cruiser's compatible parser and checks the two root TypeScript tool configurations; see [architecture](architecture.md).

The root `prepare` script installs Lefthook. `trustedDependencies` explicitly allows the `esbuild`, `lefthook`, and `workerd` installation scripts. Review trust changes rather than enabling every dependency's lifecycle scripts.

Drizzle Kit's stable release still depends on deprecated `@esbuild-kit` tooling. The root nested override keeps that tooling's esbuild on a patched version without changing Vite's esbuild. Remove the override once upstream replaces the dependency.

## Linting and formatting

`oxlint.config.ts` uses Ultracite's core, React, and bundled anti-slop presets. The Vitest preset applies only to the web workspace; package tests continue to use Bun. Anti-slop is distributed inside Ultracite, not copied into this repository or installed separately. `oxfmt.config.ts` uses Ultracite's formatter preset. The old JSON configuration files are removed so each tool has one configuration source.

`bun run lint` rejects both errors and warnings, then checks package boundaries. `bun run format` applies formatting; `bun run format:check` verifies it. Lefthook uses the same configurations for staged files, including `.mjs` scripts. `bun run typecheck` also checks both root tool configurations before checking the workspaces.

Fix code rather than disabling a preset. Keep runtime validation at named parsing boundaries. An unavoidable type assertion needs a local `SAFETY:` explanation of the evidence that makes it valid. Tests should exercise real modules or explicit dependency interfaces rather than replace module imports. Any rule exception must identify the concrete framework constraint or behavior being preserved; it must not hide untested behavior. Generated files, immutable migration history, legacy SQL fixtures, and private exports remain excluded.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
bun run setup:local you@example.com
bun run db:migrate
bun run db:seed
bun run dev
```

`setup:local` creates a private, ignored `apps/web/.dev.vars` with a random secret and refuses to overwrite an existing file. Run it once for a fresh checkout; `bun run dev` reads existing settings and does not run setup automatically. Edit `ALLOWED_EMAILS` there as needed. Vite uses port 5173; keep `BETTER_AUTH_URL` aligned with the actual origin. Local magic links appear in the development terminal instead of sending email. Never share these links or expose the development server to the public Internet. Logging links is rejected when the authentication URL is not localhost.

Local D1 state lives under `apps/web/.wrangler/`. When moving an existing checkout, preserve its `.dev.vars`, `.wrangler/`, and `exports/` under `apps/web/`; do not recreate or reseed an existing database merely because the project moved.

The checked-in `packages/database/scripts/words.json` preserves all 50 original seed entries and the later question-mark corrections. Its IDs are deterministic because the old SQL seed generated IDs inside Postgres. Importing a live export into an empty D1 instead preserves live IDs and creation dates.

## Catalogue preservation

The initial production import is complete: all 50 live rows matched the export, including IDs and creation timestamps. Do not reseed production during deployment. Private backups and verification hashes remain in the ignored `apps/web/exports/` directory; keep another backup outside this checkout.

The one-time Supabase exporter and its dedicated tests have been retired from the active tree. Recover them from commit `0016db6` if another source export is needed. No Supabase credential is needed for normal development or catalogue imports.

For a new local database, apply migrations and import a verified catalogue instead of the fallback seed:

```sh
bun run db:seed /absolute/path/to/words.json
```

The reusable importer validates the entire catalogue before executing SQL. Compare IDs, creation dates, accents, punctuation, hints, images, language, and frequency order when verifying an import. Keep a usable backup outside this checkout before removing any ignored `apps/web/exports/` files. This refactor leaves those files alone.

The importer is idempotent by `(lang, text, gloss)`. It updates content fields, never deletes words, and preserves an existing D1 ID on a natural-key match. Importing into an empty database is the way to retain all original IDs. Do not apply the fallback seed over a live export: it could overwrite custom edits. Remote imports require an explicit `--remote` argument and separate review.

Historical Supabase configuration and unrelated migrations were removed from the working tree, not from Git history. The two original catalogue SQL files remain in `packages/database/tests/fixtures/legacy-catalogue/` as independent regression fixtures. Removing local files does not delete or modify the hosted Supabase project. Old Supabase test users, sessions, settings, and progress were not imported.

## Database workflow

```sh
bun run db:generate --name=describe_the_change
bun run db:migrate
bun run db:test
```

Review generated SQL before applying it. For triggers or SQL not expressible in Drizzle, generate a custom migration:

```sh
bun run db:generate --custom --name=describe_the_change
```

Edit the generated migration. Do not use `drizzle-kit push` against production. `packages/database/drizzle.config.ts` generates SQL into `packages/database/migrations/`. The app's Wrangler configuration points to that directory; app-local commands apply it to the app's existing DB binding. This deployment wiring is not database implementation. There is one migration history, including authentication tables. Preserve migration filenames, metadata, and custom triggers when reorganizing code.

D1's `batch()` is transactional; a failed statement rolls back the batch. It is not a PostgreSQL-style interactive `db.transaction(async tx => ...)`. Better Auth's Drizzle adapter has interactive transactions disabled. Application recall saves use Drizzle's D1 batch API independently of the auth adapter. Authentication's multi-operation flows do not receive that same application-level atomicity.

D1 has no RLS. `apps/web/src/server/functions.ts` validates transport input and uses the authentication facade to derive the owner from the current session. `@vocab/database` creates a user-scoped repository; no caller-supplied owner is accepted by individual data operations. The expected user ID on answer writes is an identity check, never a source of authorization. Server-only imports must remain inside server handlers; browser bundles must never receive bindings, secrets, or arbitrary SQL access. SQL triggers enforce append-only attempts and revision checks. Account deletion with history requires a deliberate retention policy and is not exposed through the UI.

The browser outbox stores each answer under its own user-scoped localStorage key, then removes only that answer after acknowledgement. Failed saves stop the queue. Retries reuse the original ID and payload. Cross-device conflicts require explicit confirmation before discarding pending answers and reloading. Preserve command shapes and storage keys during refactors. Do not clear browser storage while answers are pending. This is save recovery, not a fully offline application.

## Checks and generated files

```sh
bun run ci
bun run test
bun run db:test
bun run format
```

`ci` builds the application, checks formatting and linting, generates Cloudflare types, runs strict TypeScript in all workspaces, and runs every workspace's tests. `bun run test` dispatches to Bun's built-in runner in `authentication`, `database`, `i18n`, and `spaced-repetition`, and to Vitest in `apps/web`. `bun run test:watch` starts the corresponding watch command in each workspace in parallel, so dependent packages do not wait for another package's watcher to exit. Do not substitute bare `bun test` at the repository root: it would also discover the web app's Vitest tests.

Package tests import from `bun:test` and need no separate test configuration file. The database and authentication test commands allow 30 seconds per test or hook for local D1 startup. Run `bun run --filter @vocab/authentication test` to target a single package, or `bun run db:test` for both database and authentication tests.

### Learning-engine regression checks

```sh
bun run --filter @vocab/spaced-repetition test
bun run --filter @vocab/spaced-repetition test:coverage
bun run --filter @vocab/spaced-repetition test --randomize --seed 42
```

The coverage command prints a report and writes an ignored `coverage/lcov.info` inside the package. GitHub Actions repeats the core suite in randomized order, using its run number as the reproducible order seed, and uploads the coverage file. Coverage helps locate unexercised code; it is not a correctness score or a substitute for assertions. Fast-check reports its own failing seed and shrink path, which are separate from Bun's test-order seed. Preserve both when reporting a failure.

Calendar tests launch isolated subprocesses with explicit timezones. They include spring and autumn transitions, repeated/missing hours, a 30-minute clock change, and a skipped civil date. They never change the running test process's timezone. The generated learner uses the public session and server interfaces with JSON round trips. Independent trace checks distinguish completed, waiting, and manually interrupted sittings, account for thinking time, and verify when repeat exceptions are actually permitted. Negative-control tests deliberately corrupt traces to prove that these assertions detect failures.

Before changing command, queue, or calendar contracts, run targeted mutation checks in a temporary checkout: intentionally break a behavior, then require a specific regression test to fail. Useful probes include constant answer IDs, revision zero, incorrect grades, dropped previous schedules, fixed 24-hour days, disabled input limits, and callback failure after a tentative state change. Do not weaken a check merely to obtain full coverage, or run fault injections against a working database.

D1 and authentication tests share the public `@vocab/database/testing` helper. It creates an ephemeral local `workerd` database, applies the real migrations, and provides cleanup. It does not depend on the test runner and never uses development state or a remote binding. No Supabase instance, Docker daemon, email key, or Cloudflare login is needed for the checks.

The app's Vite build generates `apps/web/src/routeTree.gen.ts`. Run `bun run build` after a fresh checkout before standalone `bun run typecheck`. Cloudflare runtime and binding declarations are generated by `bun run cf:types` into `apps/web/.generated/cloudflare.d.ts`; typechecking runs that command automatically. Both files are ignored. Do not replace generated runtime types with a handwritten approximation. Additional secret declarations stay in `apps/web/src/server/secrets.d.ts`.

## Production and Cloudflare Builds

`apps/web/wrangler.jsonc` retains the existing `vocab-builder` Worker, D1 database, and custom domain `https://vocab-builder.marcoazzurrini.com`. This reorganization does not create replacement infrastructure or change production traffic.

The existing Cloudflare Builds integration was updated and verified on 2026-09-14 for the Bun workspace migration. It replaces the old root-level `npm run ci` and `npx wrangler deploy` commands with these settings:

- Repository: `marcoazzurrini/vocab-builder`; production branch: `main`.
- Root directory: `/` (the workspace root, not `apps/web`).
- Build environment: `BUN_VERSION=1.4.2` and `NODE_VERSION=24`.
- `SKIP_DEPENDENCY_INSTALL=1` uses the explicit frozen install below.
- Build command: `bun install --frozen-lockfile && bun run ci`.
- Deploy command: `bun run deploy:only`.
- Build watch paths: `*`, with no exclusions, so changes to every package also deploy.
- Non-production branch builds: disabled.

The build command installs dependencies from the root `bun.lock` and rejects lockfile changes. Repository edits do not change saved dashboard settings; keep these settings aligned when changing the toolchain. GitHub Actions runs the same checks independently. Cloudflare uses its own check results rather than waiting for GitHub Actions.

For a local checked release, run `bun run deploy`. `deploy:only` skips checks and is intended for Cloudflare after the build command succeeds. Neither command applies remote migrations or seeds the database.

Before deploying code that needs a schema change, review and apply it separately with `bun run db:migrate:remote`. The interface-language feature requires `0003_ui_locale.sql` before deploying its application code. Keep `BETTER_AUTH_URL` equal to the exact HTTPS origin and `AUTH_EMAIL_MODE=resend`. Verify Wrangler uses the configured account and existing D1 binding. Never replace database IDs as part of directory cleanup.

Runtime secrets remain encrypted Worker settings, not Git files or build variables:

- `BETTER_AUTH_SECRET`: at least 32 cryptographically random characters.
- `ALLOWED_EMAILS`: comma-separated addresses allowed to use this private app. After updated configuration reaches the Worker, removed addresses cannot redeem outstanding links or access progress with existing sessions. Browser and server session reads reject the removed address and delete the presented session. Re-adding an address does not restore a deleted session.
- `RESEND_API_KEY`: a sending-only credential restricted to the verified domain.
- `EMAIL_FROM`: `Vocabulary <login@vocab-builder.marcoazzurrini.com>`.

Resend verification records are scoped to `vocab-builder.marcoazzurrini.com`; leave unrelated domain email records alone. Better Auth runs in the app Worker, with users, sessions, verification tokens, and rate-limit state in D1. Magic links expire after ten minutes and are stored hashed. Resend requests have a ten-second timeout; delivery failures return an error without exposing provider credentials or response bodies. A provider outage can make allowed and disallowed addresses distinguishable by response status. The authentication limiter trusts Cloudflare's `cf-connecting-ip` header. Email credentials stay server-side.

After deployment, verify the deployed commit and test sign-in, one-time link reuse rejection, sign-out, a guess, a recall, reload, and saved history. Keep Supabase and its export until the deployment is verified. Retiring Supabase is a separate action.

Preview builds remain disabled because bindings and the authentication origin point at production. Before enabling previews, provision an isolated staging Worker, database, and authentication origin.

### Preparing an undeployed version

When staging code and secrets without changing production traffic:

```sh
bun run ci
cd apps/web
bun run wrangler versions upload
bun run wrangler versions secret put RESEND_API_KEY
# Set the other required secrets using the same versioned command.
# Inspect binding names without printing secret values.
bun run wrangler versions view <final-version-id>
bun run wrangler versions deploy <final-version-id>@100 --yes
```

Each secret update creates another version. Deploy the final version containing both the server code and all required settings, not an earlier upload. Never put secret values in command arguments; the argument is the setting name and the value belongs in the interactive prompt. Version promotion does not replace custom-domain configuration; verify the domain attachment separately.

Ordinary `wrangler secret put` immediately deploys a new version and refuses to run when the latest version is not currently deployed. Use `versions secret put` for staged changes. The initial cutover from an asset-only Worker required uploading the server application before attaching runtime secrets: secret-only updates to the old version reported success without exposing bindings. Verify the resulting server version rather than relying only on CLI success messages.
