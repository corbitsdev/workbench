# DESIGN.md — brand, theme, and visual language

Visual canon only; flows and behavior live in the PRD. Drawn from the local
mockups in `.mockups/`. A screen that disagrees with its mockup is wrong
until a review changes the mockup.

## Theme

Three themes, persisted per user: **Light** (default: white sheet, charcoal
ink), **Dark** (near-black sheet, white ink), and **Canvas** (Corbits cream).
A theme is one block of semantic tokens (`--canvas`, `--surface`, `--ink-*`,
`--line`, `--primary`, `--danger`, …) and nothing else, so a custom theme is
one more block. Components never hardcode a hex.

## Color roles

- **Primary** buttons are charcoal with white text (inverted in Dark). Their
  icon carries the orange.
- **Orange is an accent, never a fill:** focus rings, working signals, and the
  ring around a decision waiting on you. One attention moment per view.
- **Destructive** is Canyon Red `#9E4A45` (dark `#D4857B`): solid for what
  can't be undone, text-only for everyday refusals like Deny. Irreversible
  actions arm on the first click and commit on the second.
- **Charts** use blue for succeeded and red for failed, stepped per theme and
  validated for color-vision deficiency. Never red against green.

## Type and icons

Red Hat Display for UI and prose; Space Mono only for tool names, code, and
data. Icons are Lucide at 2px stroke, never emoji or Unicode glyphs.

## Shell

One sidebar: `Workbench` wordmark with search and `+`, the Workbenches group,
the Workers group (each worker opens its own page), and a footer of profile
plus a Tools button. The profile menu holds Settings, the theme picker, and
sign-out. Library pages (workflows, artifacts, skills, insights) are reached
from a bench, never from the sidebar.

## Avatars

Use `@corbits/react-ui` `Avatar` and `AvatarStack`. Workers are rounded
squares tinted by hue; people are circles. A status dot marks state, and a
thin orange arc orbits a worker while it works, concentric with the mark.

## Workbench

No top bar. A frosted pill centered at the top shows the bench's worker, its
name, and live status; it opens the bench drawer. On desktop the drawer is
a flush side panel separated by a border, pushing the chat and composer
left. On phones it covers the chat as a full-width overlay. Its
tabs: Information (an overview of everything, including active workflows),
Artifacts, Tools, Grants, Insights, Members, Workflows.

With both side panels closed, the timeline, day divider, and composer share
a centered column capped at 1200px, with at least 32px side gutters.
Workers align left and user bubbles align right with a 16px inset; prose
holds a ~76ch measure and cards cap at 640px. The composer is one lean row:
`+`, text, voice, send.
When Replies or the bench drawer is open, the timeline's right gutter
collapses; the composer keeps a 16px gap from the nearest side panel.
User bubbles retain their 16px inset within the timeline, which fits the
available scroll width. Closing both panels restores centering.

Voice mode covers the thread with the worker's mark over a level-reactive
glow, a speaking/listening state line, and live captions. Controls:
captions, mic (mute doubles as status), end. The transcript lands in the
thread when it ends.

## Messages and cards

Workers get an avatar, name, role, and time; your own messages sit right in
a quiet bubble. Tool work collapses into one "Worked through N steps" row
that expands to each step. Approvals and connections render in-thread where
the decision happens: Allow once, Always allow (this workbench, this tool),
Ask every time, Deny.

## Pages

Anything opened full-page from a bench gets breadcrumbs back to it, plus a
back arrow. Lists are rows, not card grids. Insights is bench-scoped: runs,
success rate, median run time, artifacts, runs per day, approvals, a
per-workflow table, and recent failures. Tokens, tool calls, and latency show
as coming later until the platform reports them.

## Motion

Quiet and purposeful: state changes, never decoration. Keyboard actions such
as the palette and sidebar collapse don't animate. Enters use ease-out; the
drawer uses the drawer curve. Reduced motion keeps only fades.

## Mockup map

Shared chrome is `tokens.css`, `chrome.css`, `components.css`, and `app.js`.
Bench conversation, drawer, and voice live in `index.html` (`?bench=`);
workers in `agents.html` and `agent.html?w=`; insights in `insights.html`
(`?from=` scopes it and sets breadcrumbs). Also `new.html`, `onboarding.html`,
`workflows.html`, `routine.html`, `artifacts.html`, `skills.html`,
`tools.html`, and `settings.html`.
