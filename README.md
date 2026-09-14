# vocab-builder

A private vocabulary learning app. French first, Italian as L1. Built around
productive recall, small exposures, and one FSRS scheduler throughout learning.

## Stack

- React and TanStack Start on Cloudflare Workers.
- Cloudflare D1, Drizzle ORM, and Better Auth magic links with Resend.
- Bun workspaces and one lockfile. No separate API deployment or task orchestrator.
- Vitest for learning, UI, authentication, and isolated D1 integration tests.

Bun manages dependencies, workspace commands, and administrative scripts. Vite,
Vitest, and Wrangler retain their supported Node runtime. Production uses
Cloudflare's `workerd`. Deno is not part of the active toolchain.

## Quick start

Install Bun 1.4.2 and Node.js 24 or newer. From the repository root:

```sh
bun install --frozen-lockfile
bun run setup:local you@example.com
bun run db:migrate
bun run db:seed
bun run dev
```

Local sign-in links appear in the terminal. Do not expose the development server
or share those links. See [development and deployment](docs/development.md) for
secrets, existing catalogue imports, and production safeguards.

## Repository

```text
apps/web/                    TanStack routes, Worker wiring, UI, browser recovery
packages/spaced-repetition/  Learning sessions, grading, and scheduling
packages/database/           Scoped persistence, schema, migrations, seed and import
packages/authentication/     Sign-in policy, sessions, email delivery, client facade
tooling/                     Workspace boundary checks
docs/                        Architecture, learning rationale, development
.github/                     CI
```

Packages expose small, explicit interfaces, not their source trees. Database owns
serialization and transactions; spaced repetition owns learning rules;
authentication owns session and sign-in policy. Web binds those modules to the
Worker environment and presents their results. See [architecture](docs/architecture.md)
for interfaces, dependencies, and enforced boundaries. UI remains app-local.

Generated files, local D1 state, secrets, and existing private exports stay ignored
and app-local. The development catalogue lives in `packages/database/seed/words.json`.
Historical catalogue SQL survives as independent database test fixtures. Retired
Supabase configuration and export tooling remain in Git history. This cleanup does
not retire the hosted Supabase project or remove private backups.

## Checks

```sh
bun run ci            # Build, format check, lint, typecheck, and all Vitest tests
bun run test          # All workspaces; do not substitute `bun test`
bun run db:test       # Isolated D1 and authentication integration tests
bun run format
```

Workspaces export TypeScript source, so the app bundles their production entrypoints
without separate library builds. A fresh checkout needs `bun run build` before standalone
`bun run typecheck` to generate the TanStack route tree.

## Documentation

- [Module interfaces and dependency rules](docs/architecture.md)
- [Learning design and product direction](docs/learning-design.md)
- [Local development, database workflow, and production deployment](docs/development.md)

The live catalogue import and initial Cloudflare deployment are complete.
Cloudflare Builds is configured for the Bun workspace commands documented in the
deployment guide. Pushes to `main` run checks and deploy the existing Worker.

## Conventions

UI copy is Italian; target vocabulary is French; code and documentation are English.
Learning changes cite the principle that motivates them. Keep SQL migrations
reviewed and append-only. Keep the app mobile-first, but not mobile-only.
