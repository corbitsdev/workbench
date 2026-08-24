# Product

Corbits Workbench is the multiplayer workspace for humans and agents — a
team and its AI agents working side by side, with the same conversations
and routines. It is the default implementation of the Corbits
Platform, built on [Interchange](https://github.com/faremeter/interchange).

## The one concept

Everything in Workbench collapses to a single idea: **a workbench is a
conversation tenant.** People and agents are both principals
(Interchange). Opening an agent opens the one 1:1 DM with that agent
(`kind: chat`) — two clicks never clone a second DM. Opening a channel
opens a multi-principal room (`kind: workbench`). There is no separate
"project" or "space" object sitting above the conversation; the
conversation is the unit of work.

This is why the sidebar is Agents then Channels, not one recency list
titled Workbenches. The same Interchange agent can sit in its DM and in
many channels; product reopens or invites, and does not clone the
definition or mint a sibling instance per room. See
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

- **A sidebar of Agents then Channels** lists conversations in the
  selected bench. Agent rows are DMs (`kind: chat`); channel rows are
  rooms (`kind: workbench`). There is no one recency list titled
  Workbenches.
- **"New workbench" always creates.** It opens `/new` — the shipped
  prompt-primary picker — never a picker of existing things to join.
  Plus mints an empty channel. Nobody is auto-hosted.
- **Agents are principals, not templates.** Opening Sales opens Sales —
  the one 1:1 tenant with that agent. The same agent can sit in its DM
  and in many channels. Product reopens or invites; it does not clone
  the definition or mint a sibling instance per room. Myra is an agent
  row, not a special home slot.
- The active workbench occupies the main column; a contextual panel beside
  it carries account-wide surfaces (approvals, recent activity) that stay
  visible regardless of which workbench is open.

## First run

A brand-new account is walked through login and a credential connect, then
lands on the create surface rather than an empty shell:

1. **Login.**
2. **Credential** — connect a model provider (one-click OAuth for
   supported providers, or a pasted API key); see `packages/onboarding`.
3. **Create** — `/` hops an empty bench (zero workbenches) to `/new`, the
   prompt-primary picker (`apps/web/src/pages/new-workbench-picker.tsx`).
   A prompt box is the primary act: typing a goal and submitting mints an
   empty channel and sends that text as the first message; blank plus
   invites nobody. Named-template rows underneath mint that same empty
   channel, then invite existing principals (including Myra as a
   participant, never as mint `definitionId`) — one-click shortcuts, not
   a kind-then-Create second step. There is no Describe door and no
   `describe-first-workbench.tsx`.

A bench that already has one or more workbenches skips create and lands
on `workbenches[0]` (see `apps/web/src/pages/home-page.tsx`). Myra is an
agent row, not a home slot.

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
mat is future work (CL-6343), not current product.

Connected/settle honesty — no stale Connect after success; settle never
posting as the signed-in user; no agent 401 after GitHub already
succeeded — is the **target**, not shipped end-to-end. What ships today
is narrower: live credential reads that resolve at call, and a GitHub
settle path that can still attribute as the connecting user. Point
implementers at IMPLEMENTATION.md open questions, CL-6737, and CL-6738;
do not treat those three guarantees as current product law.

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

- **Workbench** — the product name, and the mint verb ("New workbench").
  A workbench is a conversation tenant: a DM or a channel.
- **Agent** — a coworker identity in the sidebar's Agents list. Opening
  the row reopens that agent's one DM. Never "template."
- **DM** — the one 1:1 conversation with an agent. Never cloned by a
  second open.
- **Channel** — a multi-party room. Plus mints an empty one; nobody is
  auto-hosted. Named templates invite existing agents into that room.
- **Bench** — the shared team scope a person signs into and switches
  between; shown in the bench switcher, never called a "workspace" or
  "org" in copy.

Internally these map onto platform primitives (principal, tenant, kind:
chat vs kind: workbench) — see [docs/GLOSSARY.md](docs/GLOSSARY.md) for
the authoritative table. Code and API paths generally keep the
platform's own names; "workbench" is the one exception (CL-6260), since
its package (`@corbits/chat`) is ours, not the platform's — only
user-facing surfaces use the rest of the product vocabulary above.

## Open questions

- Connected/settle honesty (no stale Connect after success; settle never
  posting as the signed-in user; no agent 401 after GitHub already
  succeeded) stays **target** until CL-6737 and CL-6738 land — see
  IMPLEMENTATION.md open questions; do not document those guarantees as
  shipped.
- The precise boundary of what Insights surfaces to a non-admin bench
  member (all tenant activity vs. only their own) is not spelled out in
  `packages/insights`'s own docs as of this writing.
