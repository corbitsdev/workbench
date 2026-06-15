See [AGENTS.md](./AGENTS.md).

# Web App Guidelines

## Data Fetching (TanStack Query is mandatory)

- **Never fetch data with `useEffect` + `useState` + `fetch`.** This is prohibited, not discouraged: it bypasses the query cache, breaks request deduplication, and loses automatic abort-on-unmount. The only acceptable approach is TanStack Query (`useQuery`/`useMutation`). See [alejandrobailo/no-use-effect](https://github.com/alejandrobailo/no-use-effect) for the reasoning and replacement patterns.
- **Place reused query hooks in `src/hooks/`**; inline `useQuery` is fine for single-use cases.
- **Gate with `enabled`.** A query that should not run on every mount (e.g. data only needed once a modal/panel is open, or that depends on a value that may be absent) must pass `enabled` so it does not fire unconditionally on page load.
- **`staleTime` policy:**
  - Catalog / static / rarely-changing data (workflow types, Gamma templates, agent catalog): `staleTime` of **at least 5 minutes** (`5 * 60_000`).
  - Dynamic workflow/session state that the user is actively driving: use the default `staleTime` (refetch freely).
- **`mutateAsync` must always have a `.catch()`** (or handle rejection in the awaiting code). A bare `void someMutation.mutateAsync(...).then(...)` swallows failures into an unhandled rejection and leaves the UI stuck. Prefer `mutate(vars, { onError, onSuccess })`, or `await ... catch`, so failures surface to the user.

## Runtime Validation (ArkType at the boundary)

- **ArkType is the canonical runtime-validation tool** for parsing data that crosses a trust boundary — API responses, anything typed `unknown`, and shared shapes that must be validated at runtime. Define an ArkType schema and parse the response through it instead of casting (`as SomeType`) untrusted data.
- **Where to use what:**
  - **Runtime boundary** (API response parse, `unknown` narrowing): ArkType schema → validated value. Never cast straight from `unknown`.
  - **Internal types** (props, local state, values you constructed and already trust): plain `interface` / `type` alias.
- Migrating every existing interface to ArkType is explicitly out of scope; migrate parse points incrementally as the surrounding code is touched. The workflow/artifact/agent-list response parsers are the reference implementations.

## Data Handling

- **No fallbacks for uncertain data**: validate everything. Use a fallback only when a single default is guaranteed by the API contract (e.g. an empty string for an initially-empty controlled input).
- Prefer explicit error handling and null checks over silent fallbacks; handle a possibly-undefined value explicitly rather than assuming a safe default.

## Component Architecture

- Keep components focused on presentation; handle API calls and state at the page level or in custom hooks.
- Derive behavior from the loaded resource, not from navigation origin or props threaded through many layers (a component's mode should come from the data it loaded, e.g. `workflow.kind`, not a prop set by whoever navigated to it).
- Use TypeScript strict mode; trust the type system. Prefer discriminated unions over optional fields when two row/record shapes are genuinely different.

## Resilience

- Wrap fallible render surfaces (panels that render server-derived data) in an error boundary so a malformed payload degrades to a recoverable message instead of a blank-screen crash.
