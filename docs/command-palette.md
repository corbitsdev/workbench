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
place into an inline bar — a width transition authored in `app.css` on
react-ui's `--duration-standard` and `--ease-in-out` (the curve its theme
documents for something growing in place; the app imports react-ui's
prebuilt stylesheet, where Tailwind motion utilities do not exist) — and
opens this same overlay. Escape collapses the bar back to the magnifier and
returns focus to it. Reduced motion needs nothing here: that stylesheet
already collapses every transition duration under
`prefers-reduced-motion`.

Both doors read and write one state, `command-palette-open-store.ts`: an
external store rather than component state, because the palette provider and
the top bar are siblings in `app.tsx`'s Shell, and a context-menu item opens
the palette too. That state outlives a remount, so it is scoped explicitly —
the provider closes search on a route change (a Back out of a result never
leaves the overlay standing) and on a bench switch. cmd+K opens and does not
toggle: react-ui's shortcut yields to text fields, and an open palette holds
focus in its own input, so Escape and the overlay are the ways back out.

Because react-ui's `CommandPalette` is a modal dialog that owns the editable
input once open, the morphed bar _shows_ the live query as text rather than
rendering a second input a click could land in — one editable search field in
the product, with the morph showing where the overlay came from. An anchored,
non-modal palette in react-ui would let that bar be the input itself.

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
`detailPath`, which is handed the entity's _own_ minted slug — an agent's
handle, a skill's name, an MCP server's slug. A slug is never derived from a
display title: slugs are immutable and titles are not, so a guess 404s the
moment the two disagree. An entity whose slug is not a slug falls back to
its opaque id, which every roster still resolves as a deep link. Routines and Library results still open their
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
