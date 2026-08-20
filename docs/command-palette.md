# Command palette

Cmd/Ctrl-K opens a global search-and-jump overlay: pages the app shell
already renders, plus workbenches, agents, workflow runs, routines, skills,
plugins, and Library artifacts, ranked and grouped, with full keyboard
navigation.

## How it's invoked

This palette is the product's only search surface (DESIGN.md → Search), and
it has exactly two doors: Cmd/Ctrl-K anywhere, and the magnifier the shell's
top bar carries on every route (`StageSearch` in
`apps/web/src/shell/stage-search.tsx`). Clicking the magnifier morphs it in
place into an inline bar — a width transition on react-ui's motion tokens
(`--duration-standard`, `--ease-spring`), not declared at all under
`prefers-reduced-motion`, where the swap is instant — and opens this same
overlay. Esc collapses the bar back to the magnifier.

Both doors read and write one state, `command-palette-open-store.ts`: an
external store rather than component state, because the palette provider and
the top bar are siblings in `app.tsx`'s Shell, and a context-menu item opens
the palette too. Because react-ui's `CommandPalette` is a modal dialog that
owns the editable input once open, the morphed bar mirrors the live query
instead of accepting keystrokes — one editable search field in the product,
with the morph showing where the overlay came from. An anchored, non-modal
palette in react-ui would let that bar be the input itself.

## Where it lives

The overlay itself — the dialog, the keyboard contract (arrows, Enter,
Escape), grouped result rendering, and `groups`/`onQueryChange`/`loading`/
`error`/`hasMore`/`onLoadMore` as first-class props — is `CommandPalette` in
[corbitsdev/react-ui](https://github.com/corbitsdev/react-ui). It knows
nothing about workbenches, routines, artifacts, or agents; it renders whatever
grouped items a consumer hands it and calls back on selection and on query
change. That is a deliberate boundary: a reusable component cannot carry one
product's vocabulary.

What workbench actually shows — which pages exist, and which workbenches,
agents, and workflow runs match what someone typed — is
`@corbits/command-palette` (`packages/command-palette`), a UI-free package
with three responsibilities:

- `buildStaticCommands` turns the app shell's own route table into palette
  commands. It never invents a destination — a route only becomes a command
  because `apps/web/src/routes.tsx` already renders it.
- `useEntitySearch` (backed by `searchEntities`) debounces a typed query
  across a set of per-category `fetch` sources and pages the combined
  results, grouped by category.
- `buildCommandPaletteGroups` assembles the final `groups` handed to
  react-ui's palette: recents, `#`/`@`/`>`/`/` scope parsing for a bare-scope
  view, and the source ordering the mock defines.

`apps/web/src/command-palette-provider.tsx` is composition only: it wires
`useEntitySearch` to live fetchers for workbenches (`@corbits/chat-ui`'s
`listWorkbenches`), agents (`listAgentDefinitions`), and workflow runs
(`/api/me/workflows/runs`), fetches routines, skills, and Library artifacts
as small per-bench catalogs (filtered client-side, the same way the static
route list already is), lists the bench's connected MCP servers as Plugins,
builds `@corbits/command-palette`'s static commands
from `apps/web/src/routes.tsx`, and hands the assembled groups to react-ui's
data-driven palette. No new endpoint beyond the ones the Routines, Skills,
and Library pages already use, no domain logic in the app.

## Groups, in display order

Commands, Workbenches, Pages, Runs, Routines, Skills, Plugins, Files, then
People & agents — the mock's `buildCmdkEntries` ordering, with Plugins (this
bench's connected MCP servers) added where the gallery sits in the rail.
Selecting a workbench, run, agent, routine, skill, or plugin result navigates
to its real route and records a recent entry (`recentsStoreForBench`,
per-bench, local to the browser); selecting a Library result opens the
Library list, since a Library item has no dedicated route of its own yet.

Agents, skills, and plugins resolve to the slug-addressed detail routes
DESIGN.md's Detail Pages section defines (`/agents/<slug>`), through
`detailPathForName` — a name that cannot name a URL resolves to the roster
instead of a fabricated slug. Routines and Library results still open their
roster deep links, which carry real content the slug placeholders do not
yet; moving them over belongs with those detail pages.

## What is not wired yet

**No scope-chip badge or footer prefix legend.** The mock's input shows a
small badge for the active `#`/`@`/`>`/`/` scope and a footer legend naming
each prefix; react-ui's `CommandPalette` has no slot for either today. The
placeholder text (`Search or jump to… (# workbenches · @ people · > actions ·
/ pages)`) carries that information as plain text instead.

**Plugins covers connected servers only.** The gallery's presets and catalog
entries are not connected things and have no detail route yet, so they are
not searchable — a follow-up on this group, never a second search surface.
