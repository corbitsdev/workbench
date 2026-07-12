# v0.6 setup guide — Auto-run

This guide covers turning on the v0.6 "Auto-run" automations (scheduled
briefs, mailbox triage, native tasks) on a deployment, what an admin should
check before a member's automations are useful, and how a member drives the
resulting surfaces. It assumes the deployment is already standing (see
[CLIENT_STANDUP.md](CLIENT_STANDUP.md)) and that Google OAuth, the LLM
credential, and Myra provisioning already work.

## Owner: flip-on runbook

Do these in order. All four owner-managed toggles referenced below live on
**Owner → Capabilities** (`/owner/capabilities` in the app).

### 1. Confirm the boot autopublish env var

`WORKFLOW_AUTOPUBLISH_ON_BOOT` (parsed in `apps/hub/src/config.ts`) must be
set to a truthy value in the environment. When set, the hub publishes its
embedded workflow definitions to the root tenant on boot and seeds one
`heartbeat` schedule per Myra member at the configured hour
(`HEARTBEAT_HOUR_UTC`, default `13`) — this is what makes the morning brief
work without any manual `deploy-workflow` step
(`apps/hub/src/services/workflow-defs-bootstrap.ts`,
`apps/hub/src/services/scheduled-trigger-seeder.ts`). If this env var is
unset, none of the steps below will produce a running brief no matter what
grants are flipped, because the heartbeat workflow definition and per-member
schedule are never created.

Per-kind/tenant routing is optional: `WORKFLOW_AUTOPUBLISH_MAP` can target
specific workflow kinds at specific tenant slugs; leaving it unset targets
every def at the root tenant, which is correct for a single-tenant
deployment.

### 2. Verify credentials

On **Owner → Capabilities**, confirm two credentials are present:

- **Granola** — required for the morning brief's call-notes source and for
  Oat. Seed via `apps/hub/bin/seed-credentials.ts` (`GRANOLA_API_KEY` env
  var) or set/replace directly from the Capabilities page.
- **The tenant LLM credential** — required for every agent launch
  (`credentialRequirements: [{ providerName: "openai-compatible", source:
"tenant" }]`); without it, Myra and the heartbeat workflow's inference step
  cannot launch.

Any tool credential that is seeded (`buildEntries()` in
`seed-credentials.ts`) but missing from the Owner UI is a bug — see
`CREDENTIAL_PROVIDER_CATALOG` in `packages/workbench-shared/src/governance.ts`
for the full catalog of what should appear here.

### 3. Flip the three feature grants

Still on **Owner → Capabilities**, the **Features** section lists three
tenant-level grants (`FEATURE_GRANT_CATALOG` in
`packages/workbench-shared/src/governance.ts`), each **disabled by
default**:

| Feature | What it does |
| --- | --- |
| **Automation scheduler** | Fires durable scheduled triggers (including the seeded heartbeat) on their configured UTC hour. |
| **Mailbox triage** | Runs ephemeral, read-only Myra triage of external inbound mail landing in a member's inbox. |
| **Task sync reconciler** | Retries task pushes left `pending` by a downstream outage, with a bounded per-task retry budget. |

Each toggle writes (or removes) an `allow` grant on the tenant's system
`member` role for `feature:<name>`/`enable`
(`apps/hub/src/routes/owner.ts`, `apps/hub/src/lib/feature-grants.ts`) —
features are deny-by-default, so an environment with no grant and no env
override has all three off. The legacy env vars (`SCHEDULER_ENABLED`,
`TRIAGE_ENABLED`, `TASKS_RECONCILER_ENABLED`) still work as an **emergency
global override**: when one is set, that feature runs regardless of the
grant, and the Capabilities page reports `forcedByEnv: true` for it instead
of letting the toggle silently do nothing.

### 4. Verify after flip-on

There is no owner-facing automation health dashboard yet — that is a
follow-up. Today, verify with:

- **Scheduler** — a member's schedule row (Preferences → Automations, or
  the seeded heartbeat) fires at its next configured UTC hour; look for the
  schedule's last-fired timestamp advancing, or a new workflow run appearing
  under that member's Workflows history.
- **Triage** — send an external-looking message into a member's inbox and
  confirm a threaded "Myra triaged: …" reply lands in the same inbox shortly
  after.
- **Logs** — `apps/hub` structured logs (via `@intx/log`) for
  `feature-grants`, `scheduled-trigger-seeder`, and the workflow-run gate
  namespaces will show grant checks, schedule fires, and any autopublish or
  gate failures.

## Admin: per-member checklist

Before a given member's automations are worth anything, confirm:

- **Granola access** — the member (or the tenant credential they rely on)
  can reach Granola; the morning brief's `granola` source
  (`BRIEF_SOURCE_CATALOG` in
  `packages/workbench-shared/src/preferences-registry.ts`) is the only live
  intake step today.
- **Brief hour** — set on the member's **Preferences → Automations**
  (`briefHourUtc`, a UTC hour picker rendered from the local time in the
  UI; server default `13`).
- **Brief sources** — the `briefSource:<key>` toggles under the same
  Automations category (currently just `briefSource:granola`) are on for
  what the member wants pulled in.
- **Autonomy preference** — `agentAutonomy` under Preferences → Agent:
  `prepare_only` (default — Myra drafts and hands back, never sends or acts
  on the member's behalf) or `execute_with_gates` (the member has
  explicitly raised it).
- **Attached workflows** — each schedule and webhook trigger carries a
  `workflowKind` (`packages/workbench-shared/src/scheduled-trigger.ts`,
  `webhook-trigger.ts`); confirm the member's schedules
  (Preferences → "My schedules" / the `SchedulePopover`) point at the
  workflow kind they expect to run, not just that a schedule exists.

## Member guidance

### Inbox — the home surface

The app opens into `/inbox`, the member's personal mailbox and "Now" feed:
a single prioritized list ranked **gate asks first, then unread mail, then
open tasks** — a blocked workflow run always outranks an unread message,
which always outranks an open task. The inbox is live-updating: the hub
streams a minimal delivery signal over Server-Sent Events
(`GET /me/inbox/events`, `apps/hub/src/routes/inbox.ts`) whenever new mail
lands, and the client refetches the list — the event carries no message
content, only enough to trigger a refresh.

### Morning brief

A per-member schedule (seeded automatically as the `heartbeat` kind, or
added manually) fires a workflow run at the configured UTC hour. Shape it
from **Preferences → Automations**:

- **Morning brief time** (`briefHourUtc`) — when it arrives, entered in
  local time and stored server-side as a UTC hour.
- **Brief sources** — which source toggles (currently Granola calls) feed
  the brief.
- **Attached workflows** — schedules and webhooks each target one workflow
  kind; manage additional schedules from the schedule popover / "My
  schedules" list.

### Triage

When a message from outside the platform lands in a member's inbox, and
mailbox triage is enabled for the tenant, an ephemeral, read-only Myra
instance summarizes it and hands back a threaded "Myra triaged: …" note in
the same inbox before the member sees it — a short-lived per-message
session, not a standing agent, and bounded so a burst of inbound mail can't
run the queue wild.

### Schedules

The `SchedulePopover` component and a member's schedules list let the
member create, edit, and delete their own durable scheduled triggers (daily,
UTC-hour cadence), each targeting a workflow kind. A trigger's payload
identity fields are always derived from the caller's own membership — a
member can never see or edit another member's schedule.

### Settings / preferences

**Settings** (`/settings`) renders every registered preference
(`packages/workbench-shared/src/preferences-registry.ts`), grouped by
category: **Agent** (autonomy), **Automations** (brief hour, brief
sources), **Notifications** (new inbox mail, approval requests), **Inbox**,
and **General** (onboarding tour). Preference writes are validated against
this registry — a write to an unregistered key is rejected — so every
member-facing toggle traces back to one file.

### Notifications bell

The app chrome's notifications bell surfaces unread counts, driven by the
same `notifyInboxMail` / `notifyGateAsks` preferences under
Settings → Notifications.

### Tasks

Tasks are a first-class object: a member (or an agent acting for them) can
create one, and the workbench can push it to a connected external system
and reconcile state back. Pushes and reconciliation happen server-side; a
push failure never surfaces as a user-facing error — when the tasks
reconciler feature is on, a pending push is retried in the background on a
bounded per-task budget.
