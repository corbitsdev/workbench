# `@workbench/web`

The workbench's single-page interface: every screen and route lives here,
composed from `@corbits/react-ui`, and builds to a static bundle the hub
serves from its own origin (`vite build`, then point `HUB_STATIC_DIR` at
`apps/web/dist`).

## Layout

Every signed-in screen renders inside the same four-column shell
(`src/shell/`), assembled from `@corbits/react-ui`'s sidebar rail and
sidebar panel pieces:

1. **Rail** — the global page icons, one per screen, each carrying its page
   name as its accessible name and hover/focus tooltip.
2. **Contextual column** — the active page's own options: channels,
   routines, the page list in full labels, with the bench switcher and the
   signed-in account pinned to the bottom.
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

## Screens

| Path         | What it shows                                                                     |
| ------------ | --------------------------------------------------------------------------------- |
| `/`          | Home — a welcome summary of the signed-in account's benches and runs.             |
| `/chat`      | The chat surface (`@corbits/chat-ui`): channels, direct chats, and threads.       |
| `/workflows` | Workflow runs executing across your benches.                                      |
| `/library`   | The artifact gallery. See "Library" below.                                        |
| `/agents`    | Agent definitions you can invite into a channel, and each channel's participants. |
| `/skills`    | A stub: skills have no registry in the hub yet, so this describes what's coming.  |
| `/approvals` | Approvals waiting on the signed-in account.                                       |
| `/settings`  | Account and bench membership settings.                                            |

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
