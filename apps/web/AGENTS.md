Follow the [root AGENTS.md](../../AGENTS.md).

- Server data goes through TanStack Query, never `useEffect`.
- Build UI from `@corbits/react-ui`; tokens, layout, and visual rules live in [DESIGN.md](../../DESIGN.md).
- Keep product rules in packages (`packages/*`); `apps/web` is routing, shell composition, and client convergence over stock hub routes.
- UI copy says what a person sees and does; never how it works inside.
- Never ship UI for a feature that is not built.
