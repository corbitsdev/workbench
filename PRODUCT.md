# Product

Corbits Workbench is the multiplayer workspace for humans and agents — a
team and its AI agents working side by side, with the same conversations,
routines, and inbox. It is the default implementation of the Corbits
Platform, built on [Interchange](https://github.com/faremeter/interchange).

## The one concept

Everything in Workbench collapses to a single idea: **a workbench is an
agent conversation.** Opening a workbench means opening a conversation —
with one agent, or with a group of people and agents — and that
conversation is also its own tenant, so its membership and grants are its
own. There is no separate "project" or "space" object sitting above the
conversation; the conversation is the unit of work.

This is why the sidebar is one flat list, not sections split by kind: every
workbench a person has, agent conversation or group conversation alike,
shows up the same way. See [docs/GLOSSARY.md](docs/GLOSSARY.md) for the
full term mapping and [docs/CHAT.md](docs/CHAT.md) for how a conversation
is built underneath.

## Who it's for

Teams adopting agentic workflows who want their agents working in the same
place their people already talk — not a separate agent console bolted onto
a chat tool. A signed-in user belongs to one or more **benches** (shared
team spaces); within a bench, they open, create, and work in workbenches.

## The guided, single-column experience

Workbench is intentionally not a multi-pane IDE. The product surface is one
column at a time:

- **A sidebar of workbenches** lists every conversation in the selected
  bench, flat, most-recently-active first. There is no separate "channels"
  vs. "chats" grouping the sidebar exposes to a person — every row is a
  workbench.
- **"+ New Workbench" always creates.** It never opens a picker of existing
  things to join — starting a new workbench is the one way in, whether the
  result is a one-on-one conversation with an agent or a group conversation
  with people and agents together.
- **Agents are templates.** Starting a new agent conversation means picking
  an agent definition (a named, reusable capability) as the starting point
  — the same definition can be launched into any number of separate
  conversations, each with its own history and its own tenant.
- The active workbench occupies the main column; a contextual panel beside
  it carries account-wide surfaces (approvals, recent activity) that stay
  visible regardless of which workbench is open.

## Plugins and Skills

A **Skill** is a named, reusable capability — instructions an agent can
pin and a workbench can install, backed by the platform's native
`kind:"skill"` asset (see `packages/skills`). Skills are visible only to
the principal or tenant that owns them; nothing crosses tenant boundaries
implicitly. Plugins extend what a workbench can do the same way Skills
extend what an agent knows — both are installable, both are scoped to the
bench or workbench that installs them, and neither requires touching
platform internals.

## Routines, through conversation

A **Routine** is the named, recurring (or manual) parent over runs of one
agent definition — a trigger (or none), a delivery destination, and a run
history. Routines are set up and managed from inside conversation, not
from a separate scheduling console: a person names what should happen
again, on what schedule, and where the result should land. See
`packages/routines` for the underlying shape.

## Inbox and approvals

Two account-wide surfaces sit outside any single workbench:

- **Inbox** projects a person's mail into three groups — action, mention,
  delivery — with mark-all-read and clear-done bulk actions. It is where a
  task's result, a mention, or a routine's delivery lands once the
  triggering activity is done. See `packages/inbox`.
- **Approvals ("needs you")** surface a paused agent run waiting on a
  human decision. There is no dedicated Approvals page — pending approvals
  show up in the Activity band, a permanent section of the contextual
  panel visible from every page, resolved by name ("`<agent name>` in
  `<bench name>`") rather than a raw id. See
  [docs/needs-you.md](docs/needs-you.md).

## Insights

Workbench exposes tenant-level usage and activity data — cost, token
consumption, and run activity — surfaced as read-only queries over data a
usage sink persists from the live inference stream. Missing data is shown
as an explicit absence, never a fabricated zero. See `packages/insights`.

## Vocabulary

User-facing surfaces (UI, docs, support) use exactly these nouns:

- **Workbench** — a single conversation, one-on-one with an agent or a
  group of people and agents. Never "channel" or "bench" in user-facing
  copy.
- **Space** — the user-facing name for a group conversation surface (a
  workbench with more than one counterpart).
- **Chat** — the user-facing name for a one-on-one conversation (with an
  agent or with a person).
- **Bench** — the shared team scope a person signs into and switches
  between; shown in the bench switcher, never called a "workspace" or
  "org" in copy.

Internally these map onto platform primitives (tenant, channel, DM) — see
[docs/GLOSSARY.md](docs/GLOSSARY.md) for the authoritative table. Code and
API paths keep the platform's own names; only user-facing surfaces use the
product vocabulary above.

## Open questions

- Whether "Space" and "Chat" as user-facing labels are fully rolled out
  across the UI or still landing incrementally is not settled in the
  docs reviewed for this pass — treat the sidebar and conversation-header
  copy as the source of truth over this document if they disagree.
- The precise boundary of what Insights surfaces to a non-admin bench
  member (all tenant activity vs. only their own) is not spelled out in
  `packages/insights`'s own docs as of this writing.
