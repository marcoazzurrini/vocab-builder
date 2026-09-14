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
apps/web/          TanStack app, Worker, authentication, DB, migrations, assets
packages/study/    Runtime-independent learning engine, commands, and tests
docs/              Learning rationale and development/deployment instructions
.github/           CI
```

`@vocab/web` imports `@vocab/study` through explicit package exports. The study
package has no React, Drizzle, or Cloudflare dependencies. Shared linting,
formatting, TypeScript defaults, and Git hooks live at the root; app-specific
configuration lives in `apps/web/`.

Generated files, local D1 state, secrets, and exports stay ignored and app-local.
The checked-in catalogue lives in `apps/web/data/words.json`. Historical catalogue
SQL survives only as independent test fixtures; other Supabase setup files remain
in Git history. The hosted Supabase project has not been retired by this cleanup.

## Checks

```sh
bun run ci            # Build, format check, lint, typecheck, and all Vitest tests
bun run test          # Both workspaces; do not substitute `bun test`
bun run db:test       # Isolated D1 and authentication integration tests
bun run format
```

Workspaces export TypeScript source, so the app bundles the study package without
a separate library build. A fresh checkout needs `bun run build` before standalone
`bun run typecheck` to generate the TanStack route tree.

## Documentation

- [Learning design and product direction](docs/learning-design.md)
- [Local development, database workflow, and production deployment](docs/development.md)

The live catalogue import and initial Cloudflare deployment are complete.
Cloudflare Builds is configured for the Bun workspace commands documented in the
deployment guide. Pushes to `main` run checks and deploy the existing Worker.

## Conventions

UI copy is Italian; target vocabulary is French; code and documentation are English.
Learning changes cite the principle that motivates them. Keep SQL migrations
reviewed and append-only. Keep the app mobile-first, but not mobile-only.
