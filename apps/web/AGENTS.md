# apps/web

React 19 + Vite + Tailwind CSS frontend. Human-facing UI for GTM Workbench.

## Key rules

- No `console.log` — nothing in web (no logger available in browser builds)
- Design tokens live in `packages/ui/src/styles.css` — do not hardcode colors or radii
- Use `@workbench/ui` primitives for buttons, inputs, and layout shells
- Prefer event handlers and derived state over `useEffect` — see `apps/web/CLAUDE.md` for detail
- All API calls go through `@workbench/client` or `@intx/hub-client`; no raw fetch in components
- SSE subscriptions reconnect automatically via `src/lib/instance-transport.ts`

## UI Quality Standards

This app serves end users, not developers. Every surface must be production-ready before it ships.

- **No incomplete UI.** Placeholder text, disabled states with no explanation, empty panels, and "coming soon" stubs are never acceptable in a shipped view. If a feature is not ready, it must not appear in the UI at all — hide it, not stub it.
- **Flag during dev, not after.** If a screen, component, or flow is incomplete while you are building it, stop and surface the gap explicitly before marking the task done. Do not silently leave rough edges.
- **UI cannot be scoped out.** During scoping and implementation, the user-facing surface is not optional. If a backend feature has no usable UI, the feature is not done. Every feature ticket must include its UI work.
- **Errors must be legible.** Never surface raw error codes, stack traces, or internal identifiers to the user. Translate failures into plain-language messages that describe what happened and what to do next.
- **Loading and empty states are required.** Every data-driven surface must handle three states explicitly: loading, empty, and error. Unhandled states are bugs, not gaps.

## Testing

Follow root [AGENTS.md](../../AGENTS.md) testing standards.
