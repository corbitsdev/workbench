# @workbench/ui

UI foundation: design tokens, base components (Button, sidebar, steps), and layout utilities.

- Design tokens live in `src/styles.css` via Tailwind v4 `@theme` directive — no `tailwind.config.ts`
- This is a custom component system; shadcn/ui is not installed
- All other `@workbench/*` packages build on these primitives
- Do not add product-specific logic here — keep components generic and composable

## Testing

Follow the repository testing standards in the [root AGENTS.md](../../AGENTS.md#testing) — red/green (tests first), the 80% coverage floor (always aim higher), and the test-quality bar.
