# @corbits/api-query

The shared hub-query envelope — `loading` / `unauthenticated` / `error` /
`ready` — and `QueryView`, the one component that renders those four
outcomes. Every page that fetches from a hub route reports through this
contract instead of inventing its own loading state or error copy.

## Contract

**Owns:**

- `APIQuery<T>`, the four-state discriminated union a query result reports.
- `toAPIQuery`, which adapts any TanStack-Query-shaped result (`isLoading`,
  `isError`, `error`, `data`, `isPending`, `fetchStatus`, `refetch`) onto
  `APIQuery<T>`.
- `UnauthenticatedError`, the sentinel a host throws from a queryFn on HTTP
  401 so `toAPIQuery` maps the failure to `kind: "unauthenticated"`.
- `ApiQueryError`, the one HTTP-query error shape (`message` + optional
  `status`) a host throws for every other request failure.
- `describeQueryError`, human, actionable copy for a failed query — never
  the raw technical message.
- `QueryView`, generic over the data type `T`: it switches on an
  `APIQuery<T>` and calls `children(data)` only in the `ready` case. Loading,
  unauthenticated, and error rendering are built in (with a `skeleton`
  prop — `"block" | "rows" | "detail"` — for the loading placeholder's
  shape); a host never re-implements them.
- `SignedOutNotice`, `ListSkeleton`, `DetailSkeleton` — the pieces
  `QueryView` composes, exported for a host that needs one standalone.

**A host injects:**

- The actual fetch: its own query hook (TanStack Query or otherwise) that
  produces the shape `toAPIQuery` expects, and its own request/schema
  validation before that.
- `label`, the noun `QueryView`'s failure copy names ("Couldn't load
  `label`").
- `children`, the render function for the `ready` state.

**Never imports:**

- No app-specific API client, hub route, or fetch call — this package
  never issues a request.
- No `@tanstack/react-query` — `toAPIQuery`'s parameter is a structural
  type, not that library's `UseQueryResult`, so a host is free to adapt any
  query library onto it.
- No workbench-specific state (`bench-context`, `query-client`'s tenant
  keys, etc.) — this package has no notion of a tenant, a bench, or a
  session beyond "authenticated or not."
