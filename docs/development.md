# Development and deployment

## Toolchain and ownership

Use Bun 1.4.2 and Node.js 24 or newer. `packageManager` in the root `package.json`
pins Bun; GitHub Actions uses the same version. Commit only `bun.lock`, not npm,
pnpm, or Yarn lockfiles. Install with `bun install --frozen-lockfile` in CI.

Bun handles dependency installation, workspace commands, and administrative
scripts. Vite, Vitest, and Wrangler still run with their Node shebangs; do not force
`--bun` onto those tools without testing their compatibility. Production runs on
Cloudflare's `workerd`, not Bun or Node. No active Deno toolchain remains.

- `apps/web` (`@vocab/web`) owns TanStack routes, React UI, browser persistence,
  server functions, Better Auth, Drizzle schema, SQL migrations, assets, and scripts.
- `packages/study` (`@vocab/study`) owns the learning engine, answer commands,
  study-day logic, deck reconstruction, and their tests. It depends on `ts-fsrs`
  and Valibot, not React, Cloudflare, or Drizzle.
- The app declares `@vocab/study: workspace:*` and imports its explicit exports.
  The package exports TypeScript source; Vite bundles it without a library build.
  Do not import another workspace through relative filesystem paths or expose
  test harnesses as production package exports.
- Root configuration covers formatting, linting, Git hooks, and common strict
  TypeScript defaults. Each workspace owns its scripts and TypeScript environment.
  The app has a separate Node configuration for build tools and script tests.

Bun filters run workspace scripts in their workspace directory. File arguments to
app scripts are therefore relative to `apps/web`, unless supplied as absolute
paths. Root scripts provide the usual commands without requiring `cd`.

The root `prepare` script installs Lefthook. `trustedDependencies` explicitly
allows the `esbuild`, `lefthook`, and `workerd` installation scripts. Review trust
changes rather than enabling every dependency's lifecycle scripts.

Drizzle Kit's stable release still depends on deprecated `@esbuild-kit` tooling.
The root nested override keeps that tooling's esbuild on a patched version without
changing Vite's esbuild. Remove the override once upstream replaces the dependency.

## Local development

From the repository root:

```sh
bun install --frozen-lockfile
bun run setup:local you@example.com
bun run db:migrate
bun run db:seed
bun run dev
```

`setup:local` creates a private, ignored `apps/web/.dev.vars` with a random secret
and refuses to overwrite an existing file. Edit `ALLOWED_EMAILS` there as needed.
Vite uses port 5173; keep `BETTER_AUTH_URL` aligned with the actual origin.
Local magic links appear in the development terminal instead of sending email.
Never share these links or expose the development server to the public Internet.
Logging links is rejected when the authentication URL is not localhost.

Local D1 state lives under `apps/web/.wrangler/`. When moving an existing checkout,
preserve its `.dev.vars`, `.wrangler/`, and `exports/` under `apps/web/`; do not
recreate or reseed an existing database merely because the project moved.

The checked-in `apps/web/data/words.json` preserves all 50 original seed entries
and the later question-mark corrections. Its IDs are deterministic because the
old SQL seed generated IDs inside Postgres. Importing a live export into an empty
D1 instead preserves live IDs and creation dates.

## Catalogue preservation

The initial production import is complete: all 50 live rows matched the export,
including IDs and creation timestamps. Do not reseed production during deployment.
Private backups and verification hashes remain in the ignored
`apps/web/exports/` directory; keep another backup outside this checkout.

The following read-only export remains available for future verification before
retiring Supabase:

1. Stop editing the source catalogue for the duration of the export.
2. Provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` through the shell or a
   secret manager. Never commit the key or put it in a `VITE_` variable. This is
   an administrative credential, not an app dependency.
3. Run `bun run db:export-words`. It only reads `words`, verifies pagination against
   the source row count, and writes `apps/web/exports/words.json`. It refuses to
   overwrite an existing export.
4. Inspect the export and keep an external backup.
5. For a new local database, apply migrations and import the export **instead of
   the fallback seed** with `bun run db:seed exports/words.json`.
6. Compare every exported field, including IDs, creation dates, accents,
   punctuation, hints, images, language, and frequency order.

The importer is idempotent by `(lang, text, gloss)`. It updates content fields,
never deletes words, and preserves an existing D1 ID on a natural-key match.
Importing into an empty database is the way to retain all original IDs. Do not
apply the fallback seed over a live export: it could overwrite custom edits.
Remote imports require an explicit `--remote` argument and separate review.

Historical Supabase configuration and unrelated migrations were removed from the
working tree, not from Git history. The two original catalogue SQL files remain
in `apps/web/tests/fixtures/legacy-catalogue/` as independent regression fixtures.
Removing local files does not delete or modify the hosted Supabase project.
Old Supabase test users, sessions, settings, and progress were not imported.

## Database workflow

```sh
bun run db:generate --name=describe_the_change
bun run db:migrate
bun run db:test
```

Review generated SQL before applying it. For triggers or SQL not expressible in
Drizzle, generate a custom migration:

```sh
bun run db:generate --custom --name=describe_the_change
```

Edit the generated migration. Do not use `drizzle-kit push` against production.
`apps/web/drizzle.config.ts` generates SQL into `apps/web/migrations/`; Wrangler
applies that same directory. Preserve migration filenames, metadata, and custom
triggers when reorganizing code.

D1's `batch()` is transactional; a failed statement rolls back the batch. It is
not a PostgreSQL-style interactive `db.transaction(async tx => ...)`. Better Auth's
Drizzle adapter has interactive transactions disabled. Application recall saves
use Drizzle's D1 batch API independently of the auth adapter. Authentication's
multi-operation flows do not receive that same application-level atomicity.

D1 has no RLS. `apps/web/src/server/functions.ts` validates input and derives the
owner from the Better Auth session. `apps/web/src/server/db/repository.ts` scopes
private queries. Server-only imports must remain inside server handlers; browser
bundles must never receive bindings, secrets, or arbitrary SQL access. SQL triggers
enforce append-only attempts and revision checks. Account deletion with history
requires a deliberate retention policy and is not exposed through the UI.

The browser outbox stores each answer under its own user-scoped localStorage key,
then removes only that answer after acknowledgement. Failed saves stop the queue.
Retries reuse the original ID and payload. Cross-device conflicts require explicit
confirmation before discarding pending answers and reloading. Preserve command
shapes and storage keys during refactors. Do not clear browser storage while
answers are pending. This is save recovery, not a fully offline application.

## Checks and generated files

```sh
bun run ci
bun run test
bun run db:test
bun run format
```

`ci` builds the application, checks formatting and linting, generates Cloudflare
types, runs strict TypeScript in both workspaces, and runs all Vitest tests.
`bun run test` invokes Vitest; `bun test` invokes a different runner and is not the
project's test command. D1 and auth tests use ephemeral local `workerd` databases,
never development state or a remote binding. No Supabase instance, Docker daemon,
email key, or Cloudflare login is needed for the checks.

The app's Vite build generates `apps/web/src/routeTree.gen.ts`. Run `bun run build`
after a fresh checkout before standalone `bun run typecheck`. Cloudflare runtime
and binding declarations are generated by `bun run cf:types` into
`apps/web/.generated/cloudflare.d.ts`; typechecking runs that command automatically.
Both files are ignored. Do not replace generated runtime types with a handwritten
approximation. Additional secret declarations stay in `apps/web/src/server/secrets.d.ts`.

## Production and Cloudflare Builds

`apps/web/wrangler.jsonc` retains the existing `vocab-builder` Worker, D1 database,
and custom domain `https://vocab-builder.marcoazzurrini.com`. This reorganization
does not create replacement infrastructure or change production traffic.

The existing Cloudflare Builds integration was updated and verified on
2026-09-14 for the Bun workspace migration. It replaces the old root-level
`npm run ci` and `npx wrangler deploy` commands with these settings:

- Repository: `marcoazzurrini/vocab-builder`; production branch: `main`.
- Root directory: `/` (the workspace root, not `apps/web`).
- Build environment: `BUN_VERSION=1.4.2` and `NODE_VERSION=24`.
- `SKIP_DEPENDENCY_INSTALL=1` uses the explicit frozen install below.
- Build command: `bun install --frozen-lockfile && bun run ci`.
- Deploy command: `bun run deploy:only`.
- Build watch paths: `*`, with no exclusions, so study-package changes also deploy.
- Non-production branch builds: disabled.

The build command installs dependencies from the root `bun.lock` and rejects
lockfile changes. Repository edits do not change saved dashboard settings; keep
these settings aligned when changing the toolchain. GitHub Actions runs the same
checks independently. Cloudflare uses its own check results rather than waiting
for GitHub Actions.

For a local checked release, run `bun run deploy`. `deploy:only` skips checks and
is intended for Cloudflare after the build command succeeds. Neither command
applies remote migrations or seeds the database.

Before deploying code that needs a schema change, review and apply it separately
with `bun run db:migrate:remote`. Keep `BETTER_AUTH_URL` equal to the exact HTTPS
origin and `AUTH_EMAIL_MODE=resend`. Verify Wrangler uses the configured account
and existing D1 binding. Never replace database IDs as part of directory cleanup.

Runtime secrets remain encrypted Worker settings, not Git files or build variables:

- `BETTER_AUTH_SECRET`: at least 32 cryptographically random characters.
- `ALLOWED_EMAILS`: comma-separated addresses allowed to use this private app.
- `RESEND_API_KEY`: a sending-only credential restricted to the verified domain.
- `EMAIL_FROM`: `Vocabulary <login@vocab-builder.marcoazzurrini.com>`.

Resend verification records are scoped to `vocab-builder.marcoazzurrini.com`;
leave unrelated domain email records alone. Better Auth runs in the app Worker,
with users, sessions, verification tokens, and rate-limit state in D1. Magic links
expire after ten minutes and are stored hashed. The authentication limiter trusts
Cloudflare's `cf-connecting-ip` header. Email credentials stay server-side.

After deployment, verify the deployed commit and test sign-in, one-time link reuse
rejection, sign-out, a guess, a recall, reload, and saved history. Keep Supabase and
its export until the deployment is verified. Retiring Supabase is a separate action.

Preview builds remain disabled because bindings and the authentication origin
point at production. Before enabling previews, provision an isolated staging
Worker, database, and authentication origin.

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

Each secret update creates another version. Deploy the final version containing
both the server code and all required settings, not an earlier upload. Never put
secret values in command arguments; the argument is the setting name and the value
belongs in the interactive prompt. Version promotion does not replace custom-domain
configuration; verify the domain attachment separately.

Ordinary `wrangler secret put` immediately deploys a new version and refuses to run
when the latest version is not currently deployed. Use `versions secret put` for
staged changes. The initial cutover from an asset-only Worker required uploading
the server application before attaching runtime secrets: secret-only updates to
the old version reported success without exposing bindings. Verify the resulting
server version rather than relying only on CLI success messages.
