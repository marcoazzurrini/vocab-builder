# Web UI foundations

The web app owns its UI locally. There is no `@vocab/ui` workspace package. Extract a package only when another web consumer needs the same components.

## Starting point

Use the standard shadcn **Nova** style, neutral theme, Geist font, and **Base UI** primitives. `components.json` records the CLI configuration. Do not create a second component API or add a wrapper that only forwards props.

The default appearance is intentional. Keep customization separate from product behavior until there is a concrete design requirement.

## Structure and dependencies

```text
src/
├── components/
│   ├── ui/          # Owned shadcn source and standard component APIs
│   └── patterns/    # App shell, navigation, and reusable UI compositions
├── features/        # Sign-in, practice screens, and product behavior
├── lib/
│   └── utils.ts     # Generated cn helper entrypoint
└── styles/
    └── globals.css  # Tailwind, semantic tokens, fonts, and global preferences
```

- Features compose UI components and patterns.
- Patterns compose UI components and receive application data and callbacks through props.
- UI components must not import patterns, features, or server services.
- Patterns must not import features or server services.
- Localization is shared infrastructure, not product behavior. Labels in both layers use Lingui.

Dependency Cruiser checks these boundaries, including `@/` imports. Tests stay beside the components they exercise.

## Tokens and styling

`src/styles/globals.css` is imported once by the root route. It contains the stock shadcn semantic tokens, such as `background`, `foreground`, `primary`, `muted`, `destructive`, and `border`.

Use those tokens and existing component variants rather than raw colors or per-screen visual overrides. Use `className` for layout. Tailwind's default spacing and typography scales are sufficient for now.

The app follows the OS color scheme using CSS media queries. Both the token values and Tailwind's `dark:` variant use the same preference, so SSR does not require a theme script or a hydration-time switch. A future theme picker must update both mechanisms together.

Global reduced-motion rules suppress component animation and transitions when requested. Fixed and full-height mobile surfaces account for safe-area insets. Fonts are bundled locally rather than fetched from a font service.

## Composition and accessibility

- Keep the shadcn APIs, including compound components and Base UI's `render` composition.
- Use `FieldGroup`, `Field`, `FieldLabel`, and `Input` for form controls. Every input needs an accessible name.
- Give icon-only buttons localized accessible labels. Hide decorative icons from assistive technology.
- Use `Sheet` for mobile navigation and `AlertDialog` for destructive confirmation. Delegate focus management, dismissal, and keyboard behavior to Base UI.
- Keep unsynced-answer deletion behind explicit confirmation. Cancellation must preserve the outbox.
- Prefer a small reusable pattern only when it hides an actual repeated interaction. Keep vocabulary-specific behavior in `features/practice`.
- Test interface labels in English and Italian. Learning content keeps its own language independently of the interface locale.

## Adding and updating components

Run the CLI from `apps/web` with Bun:

```sh
bunx --bun shadcn@latest info
bunx --bun shadcn@latest docs button
bunx --bun shadcn@latest add @shadcn/button --dry-run
```

Review the documentation and preview before adding a component. Use the official `@shadcn` registry unless another registry is explicitly selected. Add only components used by the app.

For upstream updates, review the CLI's diff before merging. Do not blindly overwrite local localization, accessibility fixes, or lint annotations. The generated component folder has narrow lint exceptions for upstream declaration style and variant exports; normal correctness checks still apply.

From the repository root, run `bun run check` and `bun run build`. Also check the changed screens at narrow mobile and desktop sizes, in light and dark mode, and with keyboard navigation.

Include a 320 px viewport, short landscape viewports, and safe-area insets. Check that long Italian recovery labels fit both the page and the confirmation dialog. Check that the navigation title and close control remain outside the unsafe area. These browser layout checks supplement jsdom tests; Chrome emulation does not replace testing Safari on iOS.
