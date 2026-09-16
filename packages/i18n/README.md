# Interface localization

`@vocab/i18n` owns the Lingui catalogs, configuration, supported locales, locale validation, browser-language negotiation, and catalog loading. It supports English (`en`) and Italian (`it`). React components and TanStack Start integration remain in `apps/web`.

## Language selection

For signed-in users, `settings.ui_locale` stores the interface preference separately from the learning settings. The value is `en`, `it`, or `NULL` for automatic browser-language selection. Existing users default to automatic selection. The account preference wins over the guest cookie, including when the account explicitly uses automatic selection.

For guests, an existing `vocab-ui-locale` cookie is respected. Without a saved choice, negotiation uses the request's `Accept-Language` header, including regional variants and quality weights. Unsupported preferences fall back to English. The browser's preferences may differ from the operating system's language.

There is no language control on the sign-in screen or in the sidebar, and no public preference endpoint. Pages resolve the language automatically from the existing preference or browser settings. The database column remains available for a future settings interface.

When the signed-in account changes, including sign-out in another tab, the app reloads the document. The new request resolves that account's language (or the guest language) and starts with an empty query cache. This behavior belongs to the app lifecycle, not a language control.

Interface language does not change vocabulary, French pronunciation, Italian glosses, answer grading, or learning settings. Translating learning content is a separate feature. Transactional authentication emails and the installation manifest are not localized by this package.

## Editing translations

English is the Lingui source locale and runtime fallback. Write all source messages in English; maintain idiomatic Italian translations in the Italian catalog. Translate the meaning and context, not individual words (for example, “Sign out” is “Esci”). Use `Trans`, `Plural`, and `useLingui` from `@lingui/react/macro` in React components:

```tsx
import { Trans, useLingui } from "@lingui/react/macro";

export function ContinueButton() {
  const { t } = useLingui();
  return (
    <button type="button" aria-label={t`Continue`}>
      <Trans>Continue</Trans>
    </button>
  );
}
```

From the repository root:

```sh
bun run i18n:extract
# Translate new entries in packages/i18n/src/locales/it/messages.po.
bun run i18n:check
bun run ci
```

Commit both `.po` catalogs. Extraction includes the shared package and web source. Lingui does not automatically translate messages; Italian translations are maintained in the catalog. The check command extracts current source messages and rejects missing translations. Vite also rejects missing translations during builds.

The Vite plugin compiles `.po` imports into separate locale chunks. Its Babel preset transforms macros with Vite 8 and React plugin 6. A separate runtime catalog build is not required. The CLI check emits ignored catalog files only to validate compilation; these are not application imports. Translation catalogs must not contain secrets: they are public browser assets.

## Runtime boundaries

- `@vocab/i18n/locales` exports browser-safe locale types, schemas, validation, and negotiation. It does not load catalogs.
- `@vocab/i18n` exports `createI18n`, `loadCatalog`, and `activateLocale`. Never retain a mutable server-side instance globally.
- `@vocab/i18n/config` exposes the common Lingui build configuration to Vite and Vitest.
- `apps/web/src/start.ts` explicitly preserves Start's default CSRF protection for server functions before running language middleware. Custom middleware replaces Start's implicit default, so this protection must remain registered.
- `apps/web/src/server/language.ts` resolves the authenticated preference and creates one Lingui instance per page request. Server functions and `/api/` requests skip language setup and retain their own authentication checks. Revoked access resolves as anonymous; unexpected authentication or database failures still surface. Personalized HTML is marked `private, no-store`.
- `apps/web/src/router.tsx` preserves Query's SSR integration. It transfers the chosen locale and document identity and waits for the matching catalog before browser hydration. The document identity only detects account changes; server-side authentication still authorizes every protected operation. Catalog functions are not serialized into HTML.
- The root document updates its `lang` attribute with the active locale. The product name remains unchanged.

Before deploying, apply `packages/database/migrations/0003_ui_locale.sql` using the existing remote migration procedure. Local migration does not update the production database.
