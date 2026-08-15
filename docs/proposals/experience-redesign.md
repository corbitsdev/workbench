# CL-6077: Experience redesign — current → proposed

One page. Names real surfaces (`apps/web/src/routes.tsx`,
`packages/settings-ui/src/section-registry.tsx`,
`packages/chat-ui/src/channel-settings/*`). No hypotheticals.

## The core move: spaces are tenants

`packages/chat-ui/src/channel-settings/surface.tsx` already says it —
*"channels are tenants, so their settings replace the whole stage."* We
finish what's started: a space is its own tenancy. It can hold **its own
named credentials, its own agents, its own grants**, inherited from the
bench unless overridden. That's why settings stop being a buried tree —
they're not a separate destination, they're a property of the space (or
agent, or routine) you're already in.

## Rail: 9 destinations → 5

| Current (`routes.tsx`) | Verdict | Proposed |
|---|---|---|
| Myra (`/`) | keep | folds into **Spaces** — Myra is a chat, not a special rail slot |
| Spaces (`/c/:id`) | keep | **Spaces** |
| Inbox (`/inbox`) | keep, scope tighter | **Inbox** — needs-you only (already the header intent) |
| Routines (`/routines`) | keep | **Routines** |
| Library (`/library`) | keep | **Library** |
| Insights (`/insights`) | kill as rail item | metrics move into the space/routine they measure (Sturgeon: low-traffic page, `insights-page.tsx`) |
| Agents (`/agents`, redirect only) | already killed (CL-5990) | confirm: no rail entry, no settings-tree page either — agents are created in-context per this proposal, directory lives one click from Spaces |
| Skills (`/skills`, redirect only) | already killed (CL-5990) | same as Agents — fold into agent creation, not a standing page |
| Settings (`SETTINGS_PATH`, footer) | keep, shrink | footer icon stays, but it opens **account + bench-wide admin only** |

**Target rail: Spaces, Routines, Library, Inbox, Search — Settings stays a footer icon, not counted in the 5.**

## Settings tree: `section-registry.tsx` flattened

Current groups: Personal (Agent, Notifications, Account) / Workspace (Bench,
People, Roles, Grants, Connections, Audit).

| Section | Verdict | Where it goes |
|---|---|---|
| `agent` (personal agent config) | move-into-context | agent's own chat — same pattern `channel-settings/surface.tsx` already gives channels |
| `chat`/Notifications | keep | Settings (genuinely global) |
| `account` | keep | Settings |
| `bench` | keep | Settings (bench is the outer tenant) |
| `people` | keep, fix | Settings — filter machine principals from the human roster (in flight per owner) |
| `roles` / `grants` | keep, contextual add | Settings for bench-wide; **also surfaces inline** on a space's Access tab (`channel-settings/access-section.tsx` already exists — extend it to grants, not just membership) |
| `connections`/`credentials-section.tsx` | merge + move-into-context | kill as the *only* entry point. Settings → Connections becomes bench-key **management** (rotate, name, revoke); **creation happens at point of use** (see below) |
| `granola-webhook-card.tsx` | kill the circularity | binding a webhook no longer requires leaving the routine. See flow 3. |
| `audit` | keep | Settings |

**Result: Settings page shrinks from 8 sections to 5 (Account, Notifications, Bench, People, Connections+Audit), all bench-scoped. Nothing space-scoped lives in the settings tree anymore.**

## Connect/credentials model: named, multi-key, scoped

Today (`credentials-section.tsx`, `connections-section.tsx`): one flat list
of credentials per tenant, no name-at-point-of-use picker, and Granola's
webhook (`granola-webhook-card.tsx`) requires an *existing* routine bound
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
  *is* the copy-this-URL-into-Granola step, no return trip.

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
   page — routines page becomes the *list* of what's running, not the only
   place to start one).
2. Pick source: catalog template or describe-to-agent.
3. Delivery channel is pre-filled as *this* space — the one you're
   already in, not a picker over every channel.
4. If the routine needs a credential (a provider key, or — for Granola —
   the inbound webhook secret), it's minted right here, inline, scoped to
   this space by default. For Granola: the last step of the wizard *is*
   the copy-this-URL-into-Granola step. No trip to Settings → Connections
   first.
5. Routine is live; runs post into the space as messages — results
   accumulate as conversation, not a separate runs table you have to go
   find.

## Chat-first shell: the middle path on dropping col2

Owner question: drop col2 entirely, make the whole app chat-based. The
recommendation below is a middle path, not full teardown — it gets the
"chat is home" feel this afternoon, and leaves the teardown decision to
real usage data instead of a guess.

**Recommended shape:**

- **Land directly in a conversation.** No listing page as the front door —
  session start resolves straight into the last-active (or Myra) chat, the
  way `/` already resolves to the Myra land hop (`routes.tsx`), extended to
  be true of every entry point, not just `/`.
- **Col2 collapses by default**, using the collapse contract that already
  exists (`packages/shell-layout/src/stage-chrome.tsx`: `Col2Width`,
  `COL2_COLLAPSED_PREFERENCE_KEY` in `apps/web/src/shell/col2-preference.ts`,
  the edge-handle affordance already rendered when col2 is collapsed). Only
  the *default* flips from open to collapsed — the mechanism is unchanged.
  A keystroke restore is new: today `toggleCol2` is click-only (no keybind
  wired in `app-shell.tsx`); add one, mirroring the edge handle it already
  renders.
- **The command palette's scoped prefixes become primary navigation.**
  `packages/command-palette/src/scope.ts` already parses `#` channels, `@`
  people & agents, `>` actions, `/` pages — four of the reference's
  eight-tab search-as-nav. Getting to parity means adding the missing
  scopes (routines, at minimum — `#`/`@`/`>`/`/` don't currently cover "find
  a routine" as its own scope) and making the palette the thing you reach
  for instead of a rail icon, not just a `Cmd+K` overlay on top of a rail
  you still primarily click.
- **Rail stays at the proposed 5** (Spaces, Routines, Library, Inbox,
  Search) — this proposal doesn't touch that count either way.

**What col2 uniquely provides in a MULTIPLAYER bench — and would be lost
by deleting it, not just collapsing it:**

Col2 today is where ambient, cross-space signal lives, not just this-space
navigation:

- The **Working group** (`apps/web/src/shell/panel-contributions.tsx`):
  tasks in flight across the bench, surfaced regardless of which space
  you're in.
- The **Activity band** (`apps/web/src/shell/activity-band.tsx`): needs-you
  approvals, mounted on every page — deliberately global, not per-space,
  so a pending approval is visible no matter what conversation you're
  reading.
- Unread state across every space at a glance — the thing a single-thread
  chat-first view cannot show without either a switcher (re-inventing col2)
  or losing the "what needs me across this whole bench" view a multiplayer
  bench depends on when several humans and agents are producing activity in
  parallel.

None of that is a single-player concern — a solo user in one conversation
doesn't miss it. It's what a *bench* (many spaces, many agents, many people)
loses if col2 is deleted rather than collapsed.

**Explicit trigger condition for deleting it later:** ship collapsed-by-
default first. If telemetry on `toggleCol2` / the edge handle shows no
meaningful re-expansion rate in real multiplayer use (i.e., people don't
reach for Working/Activity/unread-across-spaces once it's out of their
way), that's the signal to cut col2 for real — not a redesign guess made
today. Until that data exists, deleting col2 is optimizing before the
bottleneck is identified (Premature Optimization) against a surface whose
only current justification is the same owner's frustration with an
*unrelated* set of surfaces (settings burial) this proposal already fixes
without touching col2.

**Sizing:**

- **One-afternoon path (recommended):** flip the col2 default to
  collapsed (`col2CollapsedFromPreferences` default flip + initial
  `useState`), wire a keystroke to `toggleCol2`, and extend
  `PALETTE_SCOPES` with the missing tab(s) (routines) plus wiring the
  palette as the primary "get anywhere" affordance in the empty/landed
  state. All three land on existing contracts — no new state machine, no
  new component tree.
- **Full-teardown cost (not recommended without the trigger above):**
  deleting col2 means re-homing Working and the Activity band somewhere
  else in the shell (both are currently col2-only surfaces with no
  alternate render path), rebuilding cross-space unread as a first-class
  chat-first primitive, and touching every page that composes
  `contextual-panel.tsx` / `panel-contributions.tsx`, plus their test
  coverage. That's a multi-day rearchitecture of shared shell chrome, not
  a toggle flip — and it's irreversible in a way the collapse default
  isn't.
