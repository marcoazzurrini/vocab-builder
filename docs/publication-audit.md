# Repository publication audit

Audit date: 2026-10-02. Baseline: `204100e`. This is a bounded review, not a guarantee that no sensitive material exists.

## Secret and privacy checks

- Fetched origin refs and tags; the checkout is not shallow.
- Gitleaks 8.30.1 scanned Git history with `--log-opts=--all`: 78 commits inspected, one finding.
- The finding is `VITE_SUPABASE_PUBLISHABLE_KEY` in historical `.env` at `0d6b3489b6d0`. Its value uses Supabase's `sb_publishable_` format, intended for client distribution; it is not a service-role key. Historical migrations enable row-level security and limit private rows to their authenticated owner. Hosted Supabase settings were not audited.
- Gitleaks found no secrets in the tracked baseline snapshot or the logs from all 16 retained GitHub workflow runs.
- An exact-value comparison found no occurrence of the current local `BETTER_AUTH_SECRET` across 813 historical file blobs. This does not cover unknown or previously rotated secrets.
- Historical sensitive-path review found the old `.env`, placeholder environment examples, schema migrations, and catalogue test fixtures. No tracked production database exports were identified.
- Account/database identifiers, production hostname, commit authors, and documentation attribution become public. These are not authentication credentials.

Raw scanner reports, downloaded workflow logs, local database state, incident diagnostics, exports, and deployment credentials remain outside tracked files. `.gitignore` now excludes the entire `.pi/` directory. Ignoring a path does not remove existing history; the history was scanned separately.

## Redistribution notices

See [third-party notices](../THIRD_PARTY_NOTICES.md) for Lexique-derived data and bundled fonts. The Lexique archive's explicit CC BY-SA 4.0 declaration is preserved together with the documented website-link discrepancy. The full raw Lexique corpus is not published. Public visibility does not independently license the original application source code.

## Release security

PR CI has read-only repository permissions and receives no deployment credentials. Deployment credentials belong only to the GitHub `production` environment restricted to `main`. Runtime authentication/email secrets remain Cloudflare Worker secrets. Required PR checks and up-to-date branch protection must be enabled before relying on the release workflow's decision not to repeat tests after merge.

The new release workflow does not import catalogue data or apply database migrations. Its post-deployment checks cover only the homepage and signed-out session endpoint, not authenticated learning or progress persistence.
