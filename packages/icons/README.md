# @corbits/icons

The one Phosphor icon surface every app/package imports glyphs through.
Owner ruling: Phosphor (`@phosphor-icons/react`) replaced lucide-react
everywhere, bold is the only weight, and the Sparkle/Sparkles glyph is
banned outright.

- `src/index.tsx` — the curated re-export list (only glyphs the product
  actually uses are named) plus `BoldIconProvider`, the `IconContext`
  wrapper that defaults every icon under it to `weight="bold"`. Mounted
  once at each app's root (`apps/web/src/app.tsx`).
- Nothing else imports `@phosphor-icons/react` or `lucide-react` directly —
  enforced by the `no-restricted-imports` ESLint rule in `eslint.config.ts`.

Extraction-ready: this package is deliberately just re-exports plus one
context provider, no app-specific logic, so it can move into
[corbitsdev/react-ui](https://github.com/corbitsdev/react-ui) as its icon
surface without any call site changing.

## Running tests

```
cd packages/icons && bun test
```
