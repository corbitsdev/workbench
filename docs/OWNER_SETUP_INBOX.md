# Owner Setup Guide — Inbox Intake

This is the operator walkthrough for turning on external inbox sources
(Linear, Attio, Granola, and Slack) for a tenant. It assumes you already have
a running hub with the admin CLI available (`bun run admin` /
`admin:staging` / `admin:production` — see `ADMIN_CLI.md`).

Everything here is **off by default at every level** — a source only reaches
a member's inbox once the tenant feature grant, the owner toggle, and (for
member-scope sources) the member's own preference are all on, and a
credential resolves. See `IMPLEMENTATION.md` § Mailbox, automations, and
tasks → Inbox intake, and `API.md` § Inbox sources — webhooks, for the code
paths this guide operates.

## 1. Prerequisites

- **Scheduler feature grant.** Inbox intake's 60-second poller is gated by
  the same `scheduler` feature grant used by scheduled triggers and the
  automation kill switches. Either set `SCHEDULER_ENABLED=true` in the hub's
  environment, or enable it per tenant from Owner → Capabilities → Features
  (`PUT /owner/features/scheduler`). Nothing in this guide runs until this is
  on — check it first if a later step "does nothing."
- **Members need Myra instances.** Member-scope sources (Linear, Attio) only
  poll for principals that have a Myra agent instance in the tenant. Members
  who haven't logged in yet won't see inbox source settings or receive
  deliveries until they have.

## 2. Seed tenant credentials

Each source needs a tenant-level credential before it can be used by members
who share the workspace key (members can also connect their own OAuth
account for Linear/Attio — see step 8).

- Set the provider's API key env var and run **Seed tool credentials from
  env** in the admin CLI, or add/replace the key directly from
  Owner → Capabilities (the Owner UI writes the same credential row):
  - `GRANOLA_API_KEY` → `granola` tenant credential
  - `LINEAR_API_KEY` → `linear` tenant credential
  - `ATTIO_API_KEY` → `attio` tenant credential
- A source with no resolvable credential (tenant or member) never appears in
  a member's own `/me/inbox-sources` list — it's simply absent, not shown
  disabled.

## 3. Enable each source in Owner → Inbox sources

Owner → Capabilities → Inbox sources lists every source in the catalog with
an on/off toggle (`GET /owner/inbox-sources`, `PUT /owner/inbox-sources/:key`).
This is the tenant-wide ceiling grant — it does not, by itself, deliver
anything to any member.

- **Turning a source ON** makes it visible in member settings; each member
  still has to opt in themselves (except Granola, which has no per-member
  toggle — see step 6).
- **Turning a source OFF** removes it from member settings entirely — members
  do not see a disabled toggle, the source simply isn't listed. Their stored
  preference is untouched.
- **Re-enabling** restores each member's prior on/off choice — it does not
  reset everyone to off, and it does not re-enable anyone who had previously
  turned it off themselves.

### Morning brief without live intake or triage

The daily morning brief, live inbox intake, and triage are three independent
switches — the brief works with the other two fully off:

1. **Brief only:** enable the `scheduler` feature grant and the heartbeat
   schedule; members pick their brief sources in settings. The brief arrives
   as one mail per day. Leave every toggle in Owner → Inbox sources OFF — with
   no owner-enabled source, the intake tick delivers nothing even though the
   scheduler grant is on.
2. **Live intake:** additionally enable individual sources here (step 3) and
   have members opt in.
3. **Triage (auto-creating tasks from inbox items):** separately gated by the
   `triage` feature grant and each member's `tasksTriageCreate` preference.
   With triage off, brief mail and intake items simply sit in the inbox; no
   tasks are created.

## 4. Linear webhook (optional, recommended)

The poller alone picks up new Linear activity within about a minute. The
webhook delivers the same events near-instantly and shares its dedupe key
with the poller, so wiring both never double-delivers.

1. In Linear: Settings → API → Webhooks → create a webhook.
2. Set the URL to `https://<hub-host>/webhooks/linear`.
3. Subscribe to **Issues** and **Comments**.
4. Copy the signing secret Linear generates and set it as
   `LINEAR_WEBHOOK_SECRET` in the hub's environment, then redeploy/restart
   the hub.
5. Leaving `LINEAR_WEBHOOK_SECRET` unset is fine — the route is simply not
   mounted and the poller keeps working on its own.

## 5. Attio webhook (optional, recommended)

1. Register a webhook via Attio's API: `POST /v2/webhooks` with your target
   URL `https://<hub-host>/webhooks/attio` and events `task.created` and
   `task.updated`.
2. Set the secret Attio returns as `ATTIO_WEBHOOK_SECRET` in the hub's
   environment, then redeploy/restart.
3. Same fallback as Linear: unset means poller-only, no route mounted.

## 6. Granola enablement

Granola is workspace-scoped, not per-member:

1. Seed the tenant `granola` credential (step 2).
2. Turn Granola on in Owner → Inbox sources (step 3).
3. That's it — there is no member-facing Granola inbox toggle. The 60s
   poller picks up new calls, classifies them internal/external, extracts
   pain points/decisions/action items, and mails a summary to every Myra
   member who was a call participant or was mentioned in the call notes.
   Each recipient sees only their own tasks and action items in the mail
   body, never the whole team's.
4. A member only receives Granola mail if they also have the Granola inbox
   **capability** enabled for themselves (a separate self-service opt-in from
   their own settings, distinct from the workspace toggle) — if calls aren't
   reaching someone, check that first.

## 7. Slack (shipping in this release)

Slack mention intake ships in the same release as this guide. Setup:

1. Create a Slack app (or reuse an existing one) with bot scopes:
   `users:read`, `users:read.email`, `channels:history`, `channels:join`.
2. Subscribe to bot events `message.channels` and `channel_created`.
3. Set the Events URL to `https://<hub-host>/webhooks/slack`.
4. Set the app's signing secret as `SLACK_SIGNING_SECRET`, and the bot token
   as `SLACK_BOT_TOKEN` (this also seeds the tenant `slack` tool credential
   used for user lookup, permalinks, and channel auto-join).
5. Turn Slack on in Owner → Inbox sources.
6. Behavior: the bot mirrors any `@mention` of a workspace member into that
   member's inbox, resolving the Slack user to a member by email. On
   `channel_created`, the bot auto-joins the new public channel so mentions
   there are caught without manual re-invites.
7. **Known limitation at this release:** Slack intake is currently gated only
   by the owner tenant toggle — there is no separate per-member Slack
   preference yet (Linear and Attio have one; Slack does not). If the owner
   turns Slack on, every member with a resolvable email starts receiving
   mention mail; there is no way for an individual member to opt out yet.

## 8. What members do afterward

Once an owner has completed steps 2–3 (and 4–7 as applicable) for a source,
each member:

- Sees the source in their own settings (`/me/inbox-sources`) only if it is
  owner-enabled and a credential resolves for them.
- For **Linear** and **Attio**, can either use the shared tenant credential
  or connect their own account via OAuth from their settings — both work,
  member-owned credentials take priority when present.
- For **Linear** specifically, can additionally choose:
  - **What counts as activity** — assigned-only (default) or all activity.
  - **Backfill on enable** — none (default), 7 days, or 30 days of history,
    applied once on the first poll after turning Linear on.
- For **Granola**, has no toggle to flip — receiving mail depends on being a
  call participant/mentioned party plus having the Granola inbox capability
  enabled (see step 6.4).
- For **Slack**, has nothing to configure yet — see the limitation in step 7.

## How items flow, per source

| Source  | Trigger                 | Cadence                        | Scope     | Member action needed            | Dedup key                           |
| ------- | ----------------------- | ------------------------------ | --------- | ------------------------------- | ----------------------------------- |
| Linear  | Poll + optional webhook | 60s poll; webhook near-instant | Member    | Enable + connect/credential     | `linear` externalId scheme          |
| Attio   | Poll + optional webhook | 60s poll; webhook near-instant | Member    | Enable + connect/credential     | `sourceRef` (`attio:task:<id>`)     |
| Granola | Poll only               | 60s poll                       | Workspace | Enable Granola inbox capability | `artifact.source->>'granolaNoteId'` |
| Slack   | Webhook only            | Near-instant                   | Workspace | None (no opt-out yet)           | Slack `event_id`                    |

## Troubleshooting — nothing is appearing

Check the gates in this order; the first one that's off explains the gap.

1. **Feature grant** — is `scheduler` enabled for the tenant (env override or
   Owner → Capabilities → Features)? Nothing polls without it.
2. **Owner toggle** — is the source enabled in Owner → Inbox sources? If off,
   the source is invisible to members, not just paused.
3. **Member preference** — for member-scope sources, did the member actually
   turn the source on in their own settings? A disabled source never shows
   as disabled — check the toggle is actually flipped on, not just visible.
4. **Credential** — does a credential resolve for this member (tenant-shared
   key, or their own OAuth connection)? A missing credential causes a silent,
   logged skip — grep the hub logs for the source key to confirm.
5. **Lookback / backfill window** — the poller only looks back 24 hours by
   default (Linear's one-time backfill option aside). An item older than the
   window, or a Linear item whose one-time backfill window already elapsed
   on a previous enable, will not retroactively appear.
6. **Granola-specific** — confirm the member's Granola inbox **capability**
   is on (separate from the workspace Granola toggle) and that they were
   actually a call participant or were mentioned by name/email in the notes
   — name matching only fires when unambiguous.
7. **Slack-specific** — confirm the mentioned Slack user's email matches a
   member's account email exactly; there is no fuzzy matching.
