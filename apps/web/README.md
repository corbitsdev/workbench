# `@workbench/web`

The workbench's single-page interface: every screen and route lives here,
composed from `@corbits/react-ui`, and builds to a static bundle the hub
serves from its own origin (`vite build`, then point `HUB_STATIC_DIR` at
`apps/web/dist`).

## Layout

Every signed-in screen renders inside the same four-column shell
(`src/shell/`), built from `@corbits/react-ui`'s sidebar panel pieces plus a
workbench-composed rail:

1. **Rail** — global and stable: it never changes with navigation or with
   the selected bench. One icon per screen with its name captioned
   underneath (not tooltip-only), plus the bench switcher and the
   signed-in account's settings/sign-out at the bottom. Answers "where am I
   in the product, and which bench am I in". Fixed width at every
   breakpoint — it never joins the columns that withdraw as the viewport
   narrows.
2. **Contextual column** — bench-scoped and live: channels, chats, running
   routines, and notifications for the _currently selected_ bench. It
   refetches when the bench changes, not when the route does, so its
   contents can persist or travel across page navigation rather than being
   a per-page list. Answers "what is happening in this bench right now".
3. **Main pane** — whatever the route renders, taking all remaining width.
4. **Canvas** — an optional fourth column for running agents, live
   workflow walkthroughs and analytics. Collapsed by default and collapsed
   to zero width, so the main pane holds the space until it is opened.

The shell reflows as the viewport narrows rather than scrolling sideways:
the canvas column (and its toggle) is withdrawn first below roughly 1100px,
and the contextual column follows below roughly 700px, leaving the rail and
the main pane. The widths themselves are fluid (`clamp`/`vw`), so a future
chat dock squeezing the content area resizes the columns instead of
clipping them.

A new page needs one entry in `NAV_ROUTES` (`src/routes.tsx`) — the rail's
icon and the route switch both read from that single table, so a page
cannot appear in one without the other. The contextual column no longer
reads `NAV_ROUTES` at all: it has nothing to do with which pages exist.

Running routines in the contextual column are sourced today from
`@corbits/chat-ui`'s workflow-run listing (`src/shell/routine-activity.ts`)
rather than a dedicated routines package, which isn't published yet — the
column depends only on that file's `RoutineActivityItem` shape, so swapping
in a real `@corbits/routines` listing later touches nothing else.

## Screens

| Path         | What it shows                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | Home — a welcome summary of the signed-in account's benches and runs.                                                                                                      |
| `/c`         | Channel deep-link surface. On wide layouts the conversation opens in the right canvas; on compact layouts it fills the main pane. Legacy `/chat` links still resolve here. |
| `/workflows` | Workflow runs executing across your benches.                                                                                                                               |
| `/library`   | The artifact gallery. See "Library" below.                                                                                                                                 |
| `/agents`    | Agent definitions you can invite into a channel, and each channel's participants.                                                                                          |
| `/skills`    | A stub: skills have no registry in the hub yet, so this describes what's coming.                                                                                           |
| `/settings`  | Account and bench membership settings.                                                                                                                                     |

Approvals are not a page: pending permission requests land as actionable
cards in the contextual panel's Notifications band (and, when a channel is
open, inline in that channel). The `/approvals` route is gone.

## Tests

- **Unit tests** for pure modules (path helpers, reducers, parsers) sit next
  to the source file under `src/` as `*.test.ts`.
- **Integration / composition / shell probes** stay under `test/`.
- `bun test` (via the package script) runs both `./src` and `./test`.

## Library

`/library` (`src/pages/library-page.tsx`) is the artifact gallery: search,
sort, a grid/rows view toggle, and kind-colored cards, built against the
`ArtifactSummary` type from `@corbits/artifact-ui`. The presentation layer is
fully wired and tested — what isn't real yet is the data underneath it: the
hub does not expose a cross-tenant artifact store, so `LibraryRoute` passes
an honestly empty list rather than fetching a route that doesn't exist. Once
a `/api/.../artifacts` endpoint lands, only `LibraryRoute` needs to change;
`LibraryPage` needs nothing.

## Agents

`/agents` (`src/pages/agents-page.tsx`) lists the signed-in account's
channels and each one's participants (by mention handle — raw addresses are
tooltip-only, never printed on screen). "Invite agent" on a channel opens
`@corbits/chat-ui`'s `InviteAgentDialog`, the same invitable-definitions list
and invite call the chat surface's own invite flow uses.

## Skills

`/skills` (`src/pages/skills-page.tsx`) is an honest stub: there is no skill
registry in the hub yet, so the page states what a skill will be instead of
rendering invented rows.
