# DESIGN.md — Workbench UI Design System Canon

The reference for how Workbench UI decisions get made, codified out of the
"Workbench UI Overhaul v1" design review. If a screen disagrees with this
document, the screen is wrong until a review changes this document. Build
new UI here first; when `@corbits/react-ui` grows a component that covers
what a section below describes, consume it from there instead of
reimplementing it in this repo.

## Shell & Navigation

The shell has exactly one nav surface: the sidebar. There is no second nav
column and no collapse affordance — it is always present, at a fixed width.

Top to bottom:

1. **Brand row** — logo mark and a "New workbench" button (`+`) that
   opens `/new`.
2. **Bench list** — the "Workbenches" label, then rows of workbench
   conversations, with search built into the list itself. Nothing
   page-scoped ever renders in this body; it lists conversations, not
   product sections.
3. **Footer rail** — Mission Control is pinned above the rail as its own
   row; below it the rail reads Routines, Files, Skills, Agents, Plugins,
   Insights, Evals, in that order. These are utility destinations, not
   workbenches, and each is its own top-level route (`/mission-control`,
   `/routines`, `/files`, `/skills`, `/agents`, `/plugins`, `/insights`,
   `/evals`).
4. **Account row** — avatar and name, anchoring the rail, plus a separate
   settings icon beside it. The avatar+name half is a menu trigger
   (weekly usage, feedback, log out) that pops upward; the gear is a
   direct one-click control to Settings, not a menu item — Settings
   never cost two clicks to reach.

A workbench is an agent conversation, and the bench list IS the switcher —
its rows are the primary way to move between workbenches, with no separate
"switcher" control layered on top. The command palette's hidden "Switch
workbench" action is a second door onto the same list, reachable by search
rather than by scanning rows; it does not replace the sidebar as the
switching mechanism. Approvals render inside the conversation, never as a
standing band in the shell.

## Pages & Routing

The top nav on every page (`StageTopBar`) owns two things and only two
things: the page title with deep-linkable breadcrumbs at every level, and
the page's primary actions. A page body never grows its own floating
action button — if an action is primary enough to float, it belongs in the
top nav.

Every route stays reachable by direct URL and by the command palette;
sidebar and palette are two doors onto the same route table, never two
diverging ones (`apps/web/src/routes.tsx` is the single source of truth
consumed by both). A route that gets renamed or relocated leaves a redirect
behind at its old path — old links and bookmarks always land somewhere
real, never a 404.

**`/new` is the shipped create surface** (`NewWorkbenchPickerRoute`). The
primary act is a prompt: say what the workbench should do, or pick a
template shortcut underneath. The sidebar `+` and an empty-bench land on
`/` both open this route — there is no Describe door.

**`/inbox` is gone as a page** (CL-6151). The path stays as a redirect
home so old links still resolve; it is not a live groups inbox.

## Tables & Lists

The default shape for "many of the same thing" is a data table, not a card
grid:

- Sticky, uppercase column headers.
- Tabular numerals; numeric columns right-aligned.
- A checkbox column that reveals on hover, feeding a bulk action bar.
- Every row action available in the bulk bar is also on that row's
  context menu — no action exists in only one of the two places.
- Low-value columns drop first as the viewport narrows; the row's primary
  identifying column never drops.

This is a default, not a mandate. A directory that scans better as dense
grouped rows than as a table — the plugins gallery is the standing
example — keeps that idiom. Density over cards: one row per item, a small
logo tile, name, a single-line outcome sentence, a status/provenance
caption, and one honest action button that reflects the item's actual
state. Extend an existing idiom to a new directory before inventing a
third pattern; three ways to list things is a defect, not a design system.

## Detail Pages

Anything with enough content to browse gets a full page, not a panel:
`/agents/<slug>`, `/skills/<slug>`, `/plugins/<slug>`, `/routines/<slug>`,
`/files/<id>`, `/evals/<run-id>`.

Slugs are immutable once assigned and tenant-unique, enforced as a hard
database constraint — never a soft convention a migration can violate.
Where uniqueness can't be guaranteed (import races, external IDs), the
route falls back to an opaque ID rather than inventing a slug that might
collide.

Panels (slide-overs, popovers) are for quick-peek only — previewing enough
of an item to decide whether to open its full page, never a substitute for
one. If a panel grows tabs, secondary actions, or its own scroll region, it
has outgrown being a panel and needs a route.

Pages are full-width and left-aligned, with a soft max width around
1560px on very large viewports. Never a centered column — centering reads
as a document, and these are working surfaces.

## Search

Two separate surfaces, never merged, and neither opens the other (a
decision re-litigated more than once — see `docs/DECISIONS.md` → Search):

- **The magnifier in the stage top bar is a per-page filter.** It scopes to
  whatever page it's on — Files filters files, Skills filters skills — and
  never leaves that page. Clicking it morphs it in place into an inline
  input over about 200ms with the in-place morph easing (see Motion); Esc
  collapses it back, with focus returning to the magnifier. Where a page
  already has its own filter, the magnifier drives that filter directly
  rather than the page adding a second input. A page with nothing to filter
  renders no magnifier at all.
- **`Cmd+K` opens the global command palette**, reachable from anywhere
  (including a route with no stage top bar of its own) and rendered as its
  own surface, never anchored to the magnifier. See `docs/command-palette.md`
  for the palette's scoring and result-group contract.

## Color, Type & Icons

**Tokens.** All color comes from `@corbits/react-ui`'s CSS variables —
`--primary`, `--background`, `--card`, `--chart-1` through `--chart-5`,
and the rest of its semantic palette. Never hardcode a hex value or an
arbitrary Tailwind color class in product code; if a needed token doesn't
exist yet, add it in react-ui, not locally.

**Generated identity color** is the one deliberate exception: a person's
fallback avatar (no explicit picture) needs a color per principal, not a
handful of shared tokens, so it's the same `colorForPrincipal` hash
already shipped for presence cursors (`@corbits/presence/color`), paired
with a computed black/white initials color for contrast
(`@corbits/chat-ui`'s `generatedAvatarStyle`). Agents keep react-ui's
`Avatar` tone system (solid `--primary`/`--accent`/`--success`) so the two
identity kinds stay visually distinct at a glance.

**Type.** Red Hat Display for sans (UI text, headings), Space Mono for
monospace (code, IDs, numeric/tabular contexts). Both are declared once in
`apps/web/src/tailwind.css`'s `@theme` block; consumers use `font-sans` /
`font-mono`, never a font-family override.

**Icons.** Phosphor, bold weight only, imported exclusively through
`@corbits/icons` (`packages/icons/src/index.tsx`) — never straight from
`@phosphor-icons/react` or from any other icon package. That module is a
curated re-export: only glyphs the product actually uses are named there,
so a stray import can't reach for an off-list icon or a different weight.
`BoldIconProvider` sets the bold default once at the app root; call sites
never repeat `weight="bold"`. **Sparkle and Sparkles are banned outright**
— they read as a generic "AI" cliché. Every spot that used to carry one
now carries a glyph that means something specific to what it marks.

**Theme.** Light mode is the default; dark is opt-in through
`ThemeProvider`'s toggle, never inferred silently from `prefers-color-scheme`
alone.

## Motion

Durations run 150–300ms; entrances ease out, never linear or bouncy-in.
Two named easings cover the system:

- `spring` — `cubic-bezier(.2, .9, .3, 1.15)` — for things that pop into
  place with a little overshoot.
- `out` — `cubic-bezier(.2, .8, .3, 1)` — for straightforward entrances and
  exits with no overshoot.

Something that grows or shrinks _in place_ — the search bar's morph, a rail
resizing — takes `--ease-in-out` instead: an overshoot there does not read as
liveliness, it drags every neighbour in the row along with it. This
supersedes the earlier reading of `spring` as the search morph's curve
(CL-6410 review); the curves themselves are react-ui's, and its `theme.css`
documents `--ease-in-out` as the morph curve.

These are tokens on `@corbits/react-ui`'s theme, not Tailwind utilities the
product can name: the app imports react-ui's _prebuilt_ stylesheet, so a
`duration-standard` or `ease-spring` class compiles to nothing here. Product
motion is authored as a real `transition` declaration reading
`var(--duration-*)` / `var(--ease-*)`.

Motion always encodes a state change — something entering, something
transforming, focus moving — never plain decoration. If removing an
animation wouldn't remove any information, it doesn't belong. Every
transition respects `prefers-reduced-motion`, collapsing to an instant or
near-instant state change when the user has asked for it.

## Copy

Copy speaks the user's vocabulary, not the system's internals. "Running
now," never "in flight." Cron expressions render as human sentences
("every weekday at 9am"), never as the raw expression, in any surface a
person reads them.

Every action gets exactly one verb that honestly describes what it does —
"Connect" for something not yet connected, "Manage" for something already
connected — never a generic verb applied to a state where nothing has
been set up yet, and never invented synonyms for the same action across
screens. One action, one verb, everywhere that action appears.

## Tool Activity in the Conversation

What an agent did between question and answer renders as sentences, never
as the material it was made from. A tool call is described by what it
accomplished — "Searched the web for 'pricing'", "Wrote a file —
report.md", "Posted a message in Slack #general" — never by its
identifier, its namespace, or a humanised spelling of either. A result is
plain text: the prose the tool returned, or a count when it returned a
list. Raw JSON never reaches a reader, expanded or not; the only
exception is code the user actually asked for, which is prose, not
machinery.

Tense follows state: a call still running speaks in the present
("Searching…"), a settled one in the past ("Searched…"). The same rows
render mid-turn and in the persisted transcript, so nothing restyles
itself the moment a turn ends.

Tool calls render as inline chips inside the agent's message body, stacked
under the prose, one per call — never a collapsible, never a count.
Consecutive calls do not fold into a summary line or a "3 steps" total: a
count of implementation objects tells a reader nothing about what actually
happened, and hides the one call among many that might matter (a public
Slack post reads identically to three benign file reads once it's
flattened to a number). Each chip is `width:max-content` — it hugs its own
content rather than spanning the column, so a wall of calls reads as a
stack of short tags, not a wall of prose.

A chip's anatomy, left to right: a small provider tile (brand-colored,
two-letter initials) so a reader can tell at a glance which system a call
touched, then the sentence describing what happened, then a quiet status
marker. Detail opens on demand, one click, on the individual chip that has
something to show; a chip with nothing to disclose offers no control at
all. A failure says so plainly, in words, on its own chip — it is the one
state where colour appears; everything else in this strip is quiet
chrome.

## Message Alignment

Own messages align right; everyone and everything else — other people,
agents, system notices — aligns left. This is evaluated per viewer, never
baked into the message itself: a shared bench is multiplayer, so the exact
same message renders right for the person who sent it and left for every
other reader of that same bench (CL-6558, reversing an earlier reading of
the "Workbench UI Overhaul v1" mock that called for a single flat,
never-mirrored layout).

Alignment is the only thing that changes. No chat bubble, no border, no
background fill on the message itself, and no change to the avatar/name/
timestamp treatment beyond which edge it sits against — an own row mirrors
(avatar right, header and text right-anchored) rather than growing new
chrome.

Tool-use chips and generative-UI blocks (approve, connect-service,
connect-github, poll, form, steps) stay anchored under the left avatar
gutter for every author, own messages included — they read as a stack of
short tags or a card, and mirroring them to the right would land next to
the composer and break the one consistent place a reader looks for
approvals and tool activity.

## Connect cards

In-thread cards flip in place: disconnected → connected → next step. The
card never unmounts and remounts as a new row, and a connected card never
still says Connect.

GitHub for Code review is PAT-first today: Connect opens a guided
personal-access-token paste, then the same card flips to pick
repositories. A GitHub App / hosted OAuth Connect as the welcome mat is
CL-6343 (out of scope), not the shipped card.

## State Pills

Status indicators (ok / warn / error / running) use semantic colors that
are visually distinct from the brand accent (`--primary`) — a pill's color
communicates state, never brand. The four states never share a color, and
a state pill is never the only signal for status; it always sits next to
or inside a text caption that says the same thing in words.

## Responsive

Below roughly 1100px, right-rail content (recommendations, jump-back-in)
stacks under the main content instead of sitting in a fixed 320px aside.

On mobile, the page scrolls with the body under a sticky top bar — never a
fixed-height frame with an inner scroll region fighting the browser's own
scroll. The sidebar becomes an off-canvas drawer rather than persisting at
reduced width; there is no intermediate "narrow sidebar" state.

Tables drop their lowest-value columns first as width shrinks, per Tables
& Lists above; they never switch to a fundamentally different layout
(e.g., a card list) on mobile unless that directory already used a
row-based idiom on desktop.
