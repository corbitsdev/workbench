# apps/web

React 19 + Vite + Tailwind CSS frontend. Human-facing UI for GTM Workbench.

## Key rules

- No `console.log` — nothing in web (no logger available in browser builds)
- Design tokens live in `packages/ui/src/styles.css` — do not hardcode colors or radii
- Use `@workbench/ui` primitives for buttons, inputs, and layout shells
- Prefer event handlers and derived state over `useEffect` — see `apps/web/CLAUDE.md` for detail
- All API calls go through `@workbench/client` or `@intx/hub-client`; no raw fetch in components
- SSE subscriptions reconnect automatically via `src/lib/instance-transport.ts`
