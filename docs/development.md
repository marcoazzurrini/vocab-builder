# Development and migration

## Scope

The app uses TanStack Start on Cloudflare Workers, D1, Drizzle, and Better Auth.
The learning engine and the visual design are preserved. Monorepo extraction
and a package-manager change are separate tasks; this migration keeps npm and
its lockfile so infrastructure changes can be tested independently.

The new database starts with fresh users, sessions, settings, and progress.
Existing Supabase test progress is intentionally not imported. No script deletes
or modifies the Supabase project. Existing users must sign in again.

## Local development

Use Node.js 24 or newer.

```sh
npm ci
npm run setup:local -- you@example.com
npm run db:migrate
npm run db:seed
npm run dev
```

`setup:local` creates a private, ignored `.dev.vars` with a random secret. It
refuses to overwrite an existing file. Edit `ALLOWED_EMAILS` there if needed.
Vite uses port 5173; keep `BETTER_AUTH_URL` aligned with the actual origin.
Local magic links appear in the development terminal instead of sending email.
Never share these links or expose the development server to the public Internet.
Logging links is rejected when the authentication URL is not localhost.

The checked-in `data/words.json` preserves all 50 original seed entries and the
later question-mark corrections. Its IDs are deterministic because the old SQL
seed generated IDs inside Postgres. Importing a live export into an empty D1
instead preserves the live IDs and creation dates.

## Preserve the live catalogue

Do this **before retiring Supabase**. The checked-in seed cannot prove that no
additional words or edits exist in the hosted database.

1. Stop editing the source catalogue for the duration of the export.
2. Provide `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` through your shell's
   environment or secret manager. Never commit the key or put it in a `VITE_`
   variable. This is a one-time administrative credential, not an app dependency.
3. Run `npm run db:export-words`. This only reads the `words` table. It verifies
   pagination against the source row count and writes `exports/words.json`.
   It refuses to overwrite a previous export.
4. Inspect the export and keep a backup outside this checkout.
5. Apply D1 migrations, then import the export **instead of the fallback seed**:

   ```sh
   npm run db:seed -- exports/words.json
   ```

6. Verify the destination count and compare every exported field, including
   accents, punctuation, hints, images, language, and frequency order.

The importer is idempotent by `(lang, text, gloss)`. It updates content fields,
never deletes words, and preserves an existing D1 ID when a natural-key match
already exists. Importing into an empty database is therefore the way to retain
all original IDs. Do not apply the fallback seed over a live export: that could
overwrite your custom edits. Export files are ignored by Git.

## Database workflow

```sh
npm run db:generate -- --name=describe_the_change
npm run db:migrate
npm run db:test
```

Review generated SQL before applying it. For triggers or other SQL not expressible
in Drizzle, use `npx drizzle-kit generate --custom --name=describe_the_change`
and edit that migration. Do not use `drizzle-kit push` against production.

D1's `batch()` is transactional; a failed statement rolls back the whole batch.
It is not a PostgreSQL-style interactive `db.transaction(async tx => ...)`.
Better Auth's Drizzle adapter explicitly has interactive transactions disabled.
Application recall saves use Drizzle's D1 batch API, independently of the auth
adapter. Authentication's multi-operation flows do not receive that same
application-level atomicity guarantee.

There is no RLS in D1. `src/server/functions.ts` validates input and derives the
owner from the Better Auth session. `src/server/db/repository.ts` scopes all
private queries. The browser never receives database credentials or arbitrary
SQL access. SQL triggers enforce append-only attempts and revision checks.
Deleting an account with history requires a deliberate administrative retention
policy; it is not currently exposed through the UI.

The outbox persists each answer under its own user-scoped localStorage key,
then removes only that answer after acknowledgement. A failed save stops the
queue. Retry reuses the original ID and payload. A conflict with another device
requires explicitly discarding the pending answers before reloading; the UI
asks for confirmation. Do not clear browser storage while answers are pending.
This is reliable save recovery, not a fully offline application.

## Checks

```sh
npm run ci
```

This builds both bundles, generates Cloudflare types, runs strict TypeScript,
checks formatting and linting, and runs unit, UI, D1, and auth tests. D1 tests use
ephemeral local databases, never the development database or a remote binding.
No Supabase instance, Docker daemon, email key, or Cloudflare login is needed.

`src/routeTree.gen.ts` and `worker-configuration.d.ts` are generated and ignored.
Run `npm run build` after a fresh checkout before a standalone typecheck. Database
integration tests load the SQL files from `migrations/`, including custom triggers.

Drizzle Kit's stable release still depends on deprecated `@esbuild-kit` tooling.
The package override raises that tooling's nested esbuild to a patched version;
remove it once upstream replaces that dependency. No force-upgraded ORM prerelease
is required for this migration.

## Production cutover

`wrangler.jsonc` targets the existing `vocab-builder` D1 database and
`https://vocab-builder.marcoazzurrini.com`. Its custom-domain route is attached
when Wrangler deploys the Worker. Provisioning alone does not deploy the app or
retire Supabase.

1. Confirm Wrangler is authenticated to the account specified in `wrangler.jsonc`.
   The D1 database already exists; create another database only when intentionally
   replacing infrastructure, then update its configured ID.
2. Keep `BETTER_AUTH_URL` equal to the exact HTTPS application origin and
   `AUTH_EMAIL_MODE` set to `resend`.
3. Verify `vocab-builder.marcoazzurrini.com` in Resend. Its DKIM and sending SPF/MX
   records are scoped to this subdomain; leave unrelated domain email records alone.
   Use `Vocabulary <login@vocab-builder.marcoazzurrini.com>` as the sender and
   a sending-only API key restricted to this domain. Configure these Worker secrets
   using the versioned procedure below when preparing an undeployed version:
   - `BETTER_AUTH_SECRET`: at least 32 cryptographically random characters.
   - `ALLOWED_EMAILS`: comma-separated addresses allowed to use this private app.
   - `RESEND_API_KEY`: a sending credential.
   - `EMAIL_FROM`: a sender using the verified domain.
4. Apply any pending schema migrations with `npm run db:migrate:remote` before
   deploying code that requires them. Review production migrations separately.
5. The initial live catalogue import is complete: all 50 rows matched the export,
   including IDs and creation timestamps. Backups and verification hashes are in
   the ignored `exports/` directory. Do not reseed production during deployment.
6. Run `npm run ci`. For a prepared version with staged secrets, deploy that exact
   version using the procedure below. For subsequent regular releases, use
   `npm run deploy`, which checks, builds, and deploys the current code.
7. Verify sign-in, one-time link reuse rejection, sign-out, a guess, a recall,
   reload, and the saved history on the deployed origin.
8. Keep Supabase and the export available until the new deployment is verified.
   Retiring Supabase is a separate, explicit action.

## Git-based deployments

The existing `vocab-builder` Worker is connected to
`marcoazzurrini/vocab-builder` through Cloudflare Workers Builds. The production
configuration is:

- Production branch: `main`.
- Root directory: `/`.
- Build command: `npm run ci`.
- Deploy command: `npx wrangler deploy`.
- Build watch paths: `*`, with no exclusions.
- Non-production branch builds: disabled.

Cloudflare installs dependencies from the npm lockfile, then runs the build
command. Deployment runs only if all checks in that command succeed. GitHub
Actions independently runs the same checks on pushes and pull requests; Cloudflare
uses its own check results rather than waiting for the GitHub Actions result.
The build environment must provide Node.js 24 or newer.

Push reviewed changes with `git push origin main`. Check the resulting build in
Cloudflare and confirm that its commit matches the pushed commit. After deployment,
check the application at `https://vocab-builder.marcoazzurrini.com`.

Runtime secrets remain in the Worker's encrypted settings. They are not committed
to Git or copied into build variables. The existing D1 binding and custom domain
remain configured in `wrangler.jsonc`. Builds neither seed the database nor apply
remote migrations; review and apply required migrations separately before deploying
code that depends on them.

Preview builds are disabled because the current bindings and authentication origin
point at production. Before enabling previews, configure an isolated staging
Worker, database, and authentication origin. The saved version command is
`npx wrangler versions upload`, not a command that promotes a version to production.

### Preparing an undeployed server version

The previous Worker served only static assets. Upload the built server application
before attaching its runtime secrets. During this migration, secret-only updates
against the old asset-only versions reported success but exposed no secret
bindings afterward; verify the resulting server version rather than relying only
on the CLI success message.

```sh
npm run ci
npx wrangler versions upload
npx wrangler versions secret put RESEND_API_KEY
# Set the other required secrets using the same versioned command.
# Inspect the final version's binding names without printing secret values.
npx wrangler versions view <final-version-id>
npx wrangler versions deploy <final-version-id>@100 --yes
```

Each secret update creates another version. Deploy the final version containing
both the new server code and all required settings, not an earlier upload.
Version uploads do not change production traffic. Check the custom-domain
attachment in Cloudflare as well; code version promotion alone is not a substitute
for domain configuration.

Ordinary `wrangler secret put` immediately deploys a new version and refuses to
run when the latest version is not currently deployed. Use `versions secret put`
for staged changes. Never put an API key in the command argument: the argument is
the setting name, and its value belongs in the interactive prompt.

Better Auth runs inside the application Worker; there is no separate auth server
to host. D1 stores its users, sessions, verification tokens, and rate-limit state.
The authentication limiter trusts Cloudflare's `cf-connecting-ip` header.
Magic links expire after ten minutes and are stored hashed. Email delivery is
the only new external service; credentials remain server-side.
