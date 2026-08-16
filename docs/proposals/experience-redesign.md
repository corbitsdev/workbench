# CL-6077: Experience redesign — current → proposed

One page. Names real surfaces (`apps/web/src/routes.tsx`,
`packages/settings-ui/src/section-registry.tsx`,
`packages/chat-ui/src/channel-settings/*`). No hypotheticals.

## The core move: spaces are tenants

`packages/chat-ui/src/channel-settings/surface.tsx` already says it —
_"channels are tenants, so their settings replace the whole stage."_ We
finish what's started: a space is its own tenancy. It can hold **its own
named credentials, its own agents, its own grants**, inherited from the
bench unless overridden. That's why settings stop being a buried tree —
they're not a separate destination, they're a property of the space (or
agent, or routine) you're already in.

## Rail: 9 destinations → 5

| Current (`routes.tsx`)             | Verdict                  | Proposed                                                                                                                                      |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Myra (`/`)                         | keep                     | folds into **Spaces** — Myra is a chat, not a special rail slot                                                                               |
| Spaces (`/c/:id`)                  | keep                     | **Spaces**                                                                                                                                    |
| Inbox (`/inbox`)                   | keep, scope tighter      | **Inbox** — needs-you only (already the header intent)                                                                                        |
| Routines (`/routines`)             | keep                     | **Routines**                                                                                                                                  |
| Library (`/library`)               | keep                     | **Library**                                                                                                                                   |
| Insights (`/insights`)             | kill as rail item        | metrics move into the space/routine they measure (Sturgeon: low-traffic page, `insights-page.tsx`)                                            |
| Agents (`/agents`, redirect only)  | already killed (CL-5990) | confirm: no rail entry, no settings-tree page either — agents are created in-context per this proposal, directory lives one click from Spaces |
| Skills (`/skills`, redirect only)  | already killed (CL-5990) | same as Agents — fold into agent creation, not a standing page                                                                                |
| Settings (`SETTINGS_PATH`, footer) | keep, shrink             | footer icon stays, but it opens **account + bench-wide admin only**                                                                           |

**Target rail: Spaces, Routines, Library, Inbox, Search — Settings stays a footer icon, not counted in the 5.**

## Settings tree: `section-registry.tsx` flattened

Current groups: Personal (Agent, Notifications, Account) / Workspace (Bench,
People, Roles, Grants, Connections, Audit).

| Section                                 | Verdict                   | Where it goes                                                                                                                                                               |
| --------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent` (personal agent config)         | move-into-context         | agent's own chat — same pattern `channel-settings/surface.tsx` already gives channels                                                                                       |
| `chat`/Notifications                    | keep                      | Settings (genuinely global)                                                                                                                                                 |
| `account`                               | keep                      | Settings                                                                                                                                                                    |
| `bench`                                 | keep                      | Settings (bench is the outer tenant)                                                                                                                                        |
| `people`                                | keep, fix                 | Settings — filter machine principals from the human roster (in flight per owner)                                                                                            |
| `roles` / `grants`                      | keep, contextual add      | Settings for bench-wide; **also surfaces inline** on a space's Access tab (`channel-settings/access-section.tsx` already exists — extend it to grants, not just membership) |
| `connections`/`credentials-section.tsx` | merge + move-into-context | kill as the _only_ entry point. Settings → Connections becomes bench-key **management** (rotate, name, revoke); **creation happens at point of use** (see below)            |
| `granola-webhook-card.tsx`              | kill the circularity      | binding a webhook no longer requires leaving the routine. See flow 3.                                                                                                       |
| `audit`                                 | keep                      | Settings                                                                                                                                                                    |

**Result: Settings page shrinks from 8 sections to 5 (Account, Notifications, Bench, People, Connections+Audit), all bench-scoped. Nothing space-scoped lives in the settings tree anymore.**

## Connect/credentials model: named, multi-key, scoped

Today (`credentials-section.tsx`, `connections-section.tsx`): one flat list
of credentials per tenant, no name-at-point-of-use picker, and Granola's
webhook (`granola-webhook-card.tsx`) requires an _existing_ routine bound
before you can get a URL to paste into Granola — you leave the flow,
create the routine, come back.

Proposed (CL-6078 hangs off this):

- Keys are **named** ("Anthropic — prod", "Anthropic — client X") and live
  at **bench scope or space scope**. A space with no key of its own
  inherits the bench's.
- **Creation is inline, not a settings trip.** Every place a key is
  needed — space creation, agent creation, routine creation, the Granola
  webhook card — offers a picker defaulting to "use the bench key," with
  "add a key for this space" one click away, inline, without leaving the
  dialog.
- **Settings → Connections is management only**: rename, rotate, revoke,
  see what's using a key. It is never the only door to unblock a creation
  flow.
- Granola specifically: the webhook secret is minted as part of creating
  the `granola-call` routine, not after — the routine wizard's last step
  _is_ the copy-this-URL-into-Granola step, no return trip.

## Three golden flows

**1. First run: connect → talk to Myra** (`onboarding-page.tsx` today: 3
steps — name workbench, add inference credential, orient)

1. Name the workbench.
2. Add one inference key (unnamed default is fine here — it's the bench's
   first key, naming matters once there's a second).
3. Landed straight in a chat with Myra — no orientation tour, no
   dashboard. The "orient" step becomes Myra's first message, not a screen.

**2. Make an agent** (`create-agent-dialog.tsx`, CL-6074 — treat as done)

1. From Spaces, "New chat" → agent tab (`new-channel-dialog.tsx` already
   has this picker) → "Create new agent."
2. Two fields: name, what it's for. (System prompt/model/skills stay, but
   collapsed under "Advanced" — YAGNI on exposing them by default.)
3. If the agent needs its own key (a client-specific provider key, say),
   "add a key for this agent" is inline in the same dialog, defaulting to
   inherit the space's/bench's.
4. **Create & chat** — lands directly in the new DM. No settings
   round-trip, no directory page.

**3. Make a routine from a space** (`routines-page.tsx` today: standalone
page, delivery channel required at creation, Granola webhook is a separate
Connections-section card)

1. From inside a space, "New routine" (not from the standalone Routines
   page — routines page becomes the _list_ of what's running, not the only
   place to start one).
2. Pick source: catalog template or describe-to-agent.
3. Delivery channel is pre-filled as _this_ space — the one you're
   already in, not a picker over every channel.
4. If the routine needs a credential (a provider key, or — for Granola —
   the inbound webhook secret), it's minted right here, inline, scoped to
   this space by default. For Granola: the last step of the wizard _is_
   the copy-this-URL-into-Granola step. No trip to Settings → Connections
   first.
5. Routine is live; runs post into the space as messages — results
   accumulate as conversation, not a separate runs table you have to go
   find.
