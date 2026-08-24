# Product

Corbits Workbench is the multiplayer workspace for humans and agents — a
team and its AI agents working side by side, with the same conversations
and routines. It is the default implementation of the Corbits
Platform, built on [Interchange](https://github.com/faremeter/interchange).

## The one concept

Everything in Workbench collapses to a single idea: **a workbench is an
agent conversation.** Opening a workbench means opening a conversation —
with one agent, or with a group of people and agents — and that
conversation is also its own tenant, so its membership and grants are its
own. There is no separate "project" or "space" object sitting above the
conversation; the conversation is the unit of work.

This is why the sidebar is one list of workbenches, not sections split by
kind — every workbench a person has, agent conversation or group
conversation alike, shows up the same way. See
[docs/GLOSSARY.md](docs/GLOSSARY.md) for the full term mapping and
[docs/CHAT.md](docs/CHAT.md) for how a conversation is built underneath.

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
- **"+ New Workbench" always creates a room.** It opens `/new` — the shipped
  prompt-primary picker — never a picker of existing things to join, and
  never reopens an agent's one conversation. Starting a new workbench mints
  a fresh room; opening an agent (from Agents, Talk to Myra, and so on)
  find-or-reopens that agent's existing conversation.
- **Agents are templates.** An agent definition is a named, reusable
  capability. Opening an agent always find-or-reopens its one conversation
  for this bench; "+" creates a separate room and invites participants into
  it — including Myra — rather than minting another agent DM.
- The active workbench occupies the main column; a contextual panel beside
  it carries account-wide surfaces (approvals, recent activity) that stay
  visible regardless of which workbench is open.

## First run

A brand-new account is walked through login and a credential connect, then
lands on the create surface rather than an empty shell:

1. **Login.**
2. **Credential** — connect a model provider (one-click OAuth for
   supported providers, or a pasted API key); see `packages/onboarding`.
3. **Create** — `/` hops an empty bench to `/new`, the prompt-primary
   picker (`apps/web/src/pages/new-workbench-picker.tsx`). A prompt box is
   the primary act: typing a goal and submitting creates a blank
   workbench and sends that text as the first message. Prefab template
   rows underneath are one-click shortcuts, not a kind-then-Create
   second step. There is no Describe door and no
   `describe-first-workbench.tsx`.

A bench that already has one or more workbenches skips create and lands
in an existing conversation instead (see
`apps/web/src/pages/home-page.tsx`).

The shell's first-run destinations stay small on purpose (CL-6765):
Mission Control is pinned above the footer rail; the rail itself is
Routines, Files, Skills, and Agents. Insights and Evals appear on that
rail only after honest usage exists; Plugins stays reachable by deep
link and the command palette, not as a first-run rail item. New benches
should not meet an empty Plugins / Insights / Evals gallery before they
have anything to put there.

### Code review's first minute

Code review is the product scene for the template path: Connect GitHub
with a personal access token (the shipped path today) → the connect card
flips in place to pick repositories → reviewers introduce themselves as
left-aligned messages with avatars. A GitHub App / hosted OAuth welcome
mat is future work (CL-6343), not current product. Never: a stale Connect
after success; the product posting as the signed-in user; an agent 401
after GitHub already succeeded.

## Plugins and Skills

A **Skill** is a named, reusable capability — instructions an agent can
pin and a workbench can install, backed by the platform's native
`kind:"skill"` asset (see `packages/skills`). Skills are visible only to
the principal or tenant that owns them; nothing crosses tenant boundaries
implicitly. Plugins extend what a workbench can do the same way Skills
extend what an agent knows — both are installable, both are scoped to the
bench or workbench that installs them, and neither requires touching
platform internals.

## Workbench settings

Each workbench has its own full-stage settings surface, not a dialog —
reached from the workbench itself, never a separate console. It covers
what is specific to that one conversation: name, purpose, and pinned
state; its agent and human participants; per-agent name, instructions,
and capabilities; dedicated vs. shared inference capacity (CL-6117);
per-workbench connector and plugin overrides against the account default
(CL-6099); inference model/provider fallback order; applying a saved
config profile; per-person notification preferences for that workbench;
and archiving. See ARCHITECTURE.md's "Conversation as workbench data"
for how a workbench's settings relate to its tenant, and
`packages/chat-ui`'s `workbench-settings` for the implementation.

## Routines, through conversation

A **Routine** is the named, recurring (or manual) parent over runs of one
agent definition — a trigger (or none), a delivery destination, and a run
history. Routines are set up and managed from inside conversation, not
from a separate scheduling console: a person names what should happen
again, on what schedule, and where the result should land. See
`packages/routines` for the underlying shape.

## Inbox and approvals

Approvals sit outside any single workbench. Inbox does not:

- **Inbox is not a product page.** The groups UI (action / mention /
  delivery) is gone. `/inbox` stays routable only as a redirect home
  (CL-6151) so old links and bookmarks land somewhere real. The hub
  inbox API (`packages/inbox`, `/api/tenants/:tenantId/inbox`) may still
  exist as a backend; it is not a live groups page.
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

Internally these map onto platform primitives (tenant, DM) — see
[docs/GLOSSARY.md](docs/GLOSSARY.md) for the authoritative table. Code and
API paths generally keep the platform's own names; "workbench" is the one
exception (CL-6260), since its package (`@corbits/chat`) is ours, not the
platform's — only user-facing surfaces use the rest of the product
vocabulary above.

## Open questions

- Whether "Space" and "Chat" as user-facing labels are fully rolled out
  across the UI or still landing incrementally is not settled in the
  docs reviewed for this pass — treat the sidebar and conversation-header
  copy as the source of truth over this document if they disagree.
- The precise boundary of what Insights surfaces to a non-admin bench
  member (all tenant activity vs. only their own) is not spelled out in
  `packages/insights`'s own docs as of this writing.
