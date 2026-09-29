# vocab-builder

A private vocabulary learning app. French first, Italian as L1. Built around productive recall, small exposures, and one FSRS scheduler throughout learning.

## Stack

- React, TanStack Start/Router, and TanStack Query on Cloudflare Workers.
- App-local shadcn components with Base UI and Tailwind CSS.
- Cloudflare D1, Drizzle ORM, and Better Auth magic links with Resend.
- Bun workspaces and one lockfile. No separate API deployment or task orchestrator.
- Bun's built-in test runner for packages; Vitest for the web app.

Bun manages dependencies, workspace commands, administrative scripts, and package tests. Vite, web-app Vitest, and the Wrangler CLI retain their Node runtime. Database and authentication tests use Wrangler's local D1 proxy from Bun. Production uses Cloudflare's `workerd`. Deno is not part of the active toolchain.

## Quick start

Install Bun 1.4.2 and Node.js 24 or newer. From the repository root:

```sh
bun install --frozen-lockfile
bun run setup:local you@example.com
bun run db:migrate
bun run catalogue:import:families --allow-drafts --activate
bun run dev
```

This installs the checked-in 1,000-family French/Italian curriculum: 1,049 lemmas and 35 selected inflected forms. Italian cues are machine-authored drafts for personal dogfooding. The importer backs up the local database and preserves existing review histories. No corpus download is needed to use the checked-in curriculum.

Local sign-in links appear in the terminal. Do not expose the development server or share those links. See [development and deployment](docs/development.md) for secrets, existing catalogue imports, and production safeguards.

## Install as an app

On the HTTPS deployment, use your browser's install action. On iPhone or iPad, open the site in Safari and choose Share → Add to Home Screen (enable Open as Web App if offered). Installation adds a standalone app window; an internet connection is still required for sign-in and practice. There is no service worker or offline cache, and installation does not change answer persistence or authentication.

The manifest lives in `apps/web/public/manifest.webmanifest`. Installation icons use the app's colors and are generated from `apps/web/public/favicon.svg`. To regenerate the checked-in PNGs after changing that SVG, run from the repository root:

```sh
bunx --yes --package sharp-cli sharp -i apps/web/public/favicon.svg -o apps/web/public/icons/pwa-192.png resize 192 192
bunx --yes --package sharp-cli sharp -i apps/web/public/favicon.svg -o apps/web/public/icons/pwa-512.png resize 512 512
bunx --yes --package sharp-cli sharp -i apps/web/public/favicon.svg -o apps/web/public/icons/apple-touch-icon.png resize 180 180
```

Keep the symbol inside the centered 80%-diameter circle so the 512px icon remains safe under maskable icon crops. Icon generation is a maintenance step, not a build or runtime dependency.

## Repository

```text
apps/web/                    TanStack routes, Worker wiring, UI, browser recovery
packages/spaced-repetition/  Learning sessions, grading, and scheduling
packages/database/           Scoped persistence, schema, migrations, seed and import
packages/authentication/     Sign-in policy, sessions, email delivery, client facade
packages/i18n/               Italian/English catalogs, locale policy, Lingui runtime
docs/                        Architecture, learning rationale, development
.github/                     CI
```

Packages expose small, explicit interfaces, not their source trees. Database owns serialization and transactions; spaced repetition owns learning rules; authentication owns session and sign-in policy. Web binds those modules to the Worker environment and presents their results. See [architecture](docs/architecture.md) for interfaces, dependencies, and enforced boundaries. UI remains app-local.

Generated files, local D1 state, secrets, and existing private exports stay ignored and app-local. The development catalogue and its importer live together in `packages/database/scripts/`. The local settings helper lives in `apps/web/scripts/`. Historical catalogue SQL survives as independent database test fixtures. Retired Supabase configuration and export tooling remain in Git history. This cleanup does not retire the hosted Supabase project or remove private backups.

## Checks

```sh
bun run ci            # Build, format check, lint, typecheck, and all tests
bun run test          # All workspaces: Bun for packages, Vitest for web
bun run db:test       # Isolated D1 and authentication integration tests
bun run format
```

Use `bun run test:watch` to watch all workspaces. Inside a package, `bun run test` and `bun run test:watch` use Bun directly. Bare `bun test` at the repository root is not the full-suite command: the web app still requires Vitest.

Workspaces export TypeScript source, so the app bundles their production entrypoints without separate library builds. A fresh checkout needs `bun run build` before standalone `bun run typecheck` to generate the TanStack route tree.

## Documentation

- [Module interfaces and dependency rules](docs/architecture.md)
- [Web UI foundations, composition, and component maintenance](apps/web/DESIGN.md)
- [Learning design and product direction](docs/learning-design.md)
- [Vocabulary catalogue: research, JSON format, schema, import and remaining work](docs/catalogue.md)
- [Local development, database workflow, and production deployment](docs/development.md)
- [Interface languages and translation workflow](packages/i18n/README.md)

The original live catalogue import and Cloudflare deployment are complete. The new French Lexique catalogue is a separate local-only pilot; its generated Italian cues remain drafts. See the catalogue guide before importing or publishing it. Cloudflare Builds is configured for the Bun workspace commands documented in the deployment guide. Pushes to `main` run checks and deploy the existing Worker.

## Conventions

UI copy supports Italian and English through Lingui, with English source messages and idiomatic Italian translations. Existing account preferences or browser settings determine the language; there is currently no language selector. Target vocabulary remains French with Italian glosses, independent of the interface language. Code and documentation are English. Learning changes cite the principle that motivates them. Keep SQL migrations reviewed and append-only. Keep the app mobile-first, but not mobile-only.
