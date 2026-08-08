# Command palette

Cmd/Ctrl-K opens a global search-and-jump overlay: pages the app shell
already renders, plus channels and workflow runs, ranked and grouped, with
full keyboard navigation and no scale or position motion — just a fade.

## Where it lives

The overlay itself — the dialog, the keyboard contract (arrows, Enter,
Escape), grouped result rendering, and the loading/empty/error/load-more
states — is `CommandPalette` in
[corbitsdev/react-ui](https://github.com/corbitsdev/react-ui). It knows
nothing about channels, routines, artifacts, or agents; it renders whatever
grouped items a consumer hands it and calls back on selection. That is a
deliberate boundary: a reusable component cannot carry one product's
vocabulary.

What workbench actually shows — which pages exist, and which channels and
workflow runs match what someone typed — is `@corbits/command-palette`
(`packages/command-palette`), a UI-free package with two responsibilities:

- `buildStaticCommands` turns the app shell's own route table into palette
  commands. It never invents a destination — a route only becomes a command
  because `apps/web/src/routes.tsx` already renders it.
- `searchEntities` matches already-fetched channels and workflow runs
  against a query, grouped and paginated.

`apps/web/src/command-palette-provider.tsx` is composition only: it fetches
channels (`@corbits/chat-ui`'s `listChannels`) and workflow runs
(`/api/me/workflows/runs`) the same way the Chat and Workflows pages already
do, builds `@corbits/command-palette`'s static commands from
`apps/web/src/routes.tsx`, and hands the result to react-ui's palette. No
new endpoint, no domain logic in the app.

## What is not wired yet

**Artifacts and agent definitions have no cross-tenant search endpoint
today.** The Library page already documents this for artifacts — it renders
against `ArtifactSummary` with an empty list until `/api/.../artifacts`
exists — and Agents has no equivalent for agent definitions either; the
Agents page only lists per-channel invitable definitions. Rather than fake a
result set, the palette's entity search covers channels and routines only
until those endpoints land.

**Live, query-driven server search is blocked on a react-ui publish.** The
component currently pinned in `package.json`
(`github:corbitsdev/react-ui#d6837c6e59c5a52db4fa3402584344a17b561a68`)
predates the data-driven `CommandPalette` — it owns its own query state
internally and filters a fixed `actions` list, with no way to hand a
keystroke back out to the caller. Today's wiring fetches channels and runs
once when the palette opens and lets that built-in match-as-you-type filter
the full list.

The rebuilt, data-driven `CommandPalette` — with `groups`, `onQueryChange`,
`loading`, `error`, and `hasMore`/`onLoadMore` as first-class props — lives
on react-ui's `command-palette` branch, commit `10bf9bf353781d56266150d51776544ec5e4af05`.
Once that is published and workbench's `@corbits/react-ui` dependency moves
to the published version, `command-palette-provider.tsx` switches to
debouncing the typed query into `@corbits/command-palette`'s `searchEntities`
and passing the result through `onQueryChange`, gaining real pagination and
loading state in the process.
