# The local rip

A "local rip" is the whole platform proof, run by hand on your own
machine, with your own real key: sign up, get a personal bench, connect a
real inference provider, and watch a working workbench come up in front of
you — nothing mocked, nothing skipped. `scripts/e2e/local-rip.test.ts`
proves the same path with a stubbed provider probe and a scratch database
(see its own header comment); this doc is the honest, no-shortcuts version
for a person, not CI.

This covers the whole path: sign-up through a fully connected bench, then
dispatching a task — by hand or by letting Myra pick the agent — reading
its trace, and turning it into a routine.

## Prerequisites

- [Bun](https://bun.sh) >= 1.2
- A local [Postgres](https://www.postgresql.org) 17 with pgvector — see
  [README.md](../README.md#running-locally) for the `brew install` line
- `git` on your `PATH` — the onboarding connect flow pushes the default
  workflow definitions into the hub over git smart-HTTP
  (`packages/hub-client/src/workflow-push.ts`'s `createGitWorkflowPusher`
  shells out to the system `git` binary; it fails loud with an install
  hint if `git` isn't found)
- A real API key for the provider you want to connect (this walkthrough
  uses OpenRouter's OAuth connect, which needs no key of your own to
  paste — see below — but any of the providers in
  [`packages/hub-client/src/catalog-seed-data.ts`](../packages/hub-client/src/catalog-seed-data.ts)
  works the same way with a pasted key)

## 1. Bring up a clean stack

```sh
cp .env.example .env
bun run reset   # only if you have a previous local-rip's state lying around
bun run dev
```

`bun run reset` drops the schema and every on-disk asset directory
`bun run dev`/`bun run setup`/`bun run seed` created — skip it on a
genuinely fresh checkout. `bun run dev` validates `.env`, confirms
`DATABASE_URL` is reachable, applies pending migrations, builds the web
UI, seeds the administrator account, and starts the hub, one sidecar, and
the web dev server together (see [README.md](../README.md#running-locally)
for exactly what it checks). Leave `ANTHROPIC_API_KEY` unset in `.env` for
this walkthrough — the point is proving a bench with no hub-owned seed
model gets fully seeded through a person's own connected credential, not
through the operator's key.

Once `bun run dev` reports the hub and web server up, open
`http://localhost:3000` (or whatever `BASE_URL`/`PORT` you set in `.env`).

## 2. Sign up

The app root renders the sign-in screen when you're not authenticated
(`apps/web/src/app.tsx`'s `<AuthScreen>`); toggle it to sign-up and create
an account with any email/password. `WORKBENCH_SIGNUP` defaults to
`closed` — `bun run dev` forces it `open` for the duration of the dev
process regardless of what `.env` says (unless `.env` sets it explicitly),
so self-serve sign-up works out of the box here. On a deployed hub with no
override, the same sign-up attempt is refused at `POST /api/auth/sign-up/email`
with `signup_closed` — `scripts/e2e/local-rip.test.ts`'s first hop proves
exactly that response.

## 3. Name your bench

Signing up lands you on `/onboarding`. Submitting the "Create your
workbench" name form calls `POST /api/onboarding/provision` with that name,
which mints your personal bench through the platform's native
tenant-creation route. With no `ANTHROPIC_API_KEY` configured, the response
reports the bench as provisioned but unseeded (`seeded: false`, with a
`seedSkipReason` naming why) — the UI keeps you on the credential step
rather than pretending you're done.

## 4. Connect a provider

The credential step offers a "Connect with OpenRouter" button (PKCE OAuth,
no client id or secret needed — OpenRouter's connect works with zero extra
config) alongside a paste-a-key form for any provider in
`CREDENTIAL_PROVIDERS` (`apps/web/src/onboarding.ts`), Anthropic included.
Either path:

1. proves your key or exchanged token with a real, free call against the
   provider's own auth-gated endpoint (`testProviderCredential` —
   `packages/hub-client/src/credential-test.ts`) before storing anything;
2. plants it as a credential on your bench alongside that provider's
   curated model catalog;
3. deploys and (unlike the OAuth callback's own fast half) confirms every
   default workflow the platform ships: **echo**, **assistant**,
   **workbench-digest**, and **recurring-task** — the last one deployed but
   never run directly; it exists only so "Make this a routine" (see
   below) always has a definition to prefill against
   (`packages/hub-client/src/seed.ts`'s `DEFAULT_WORKFLOWS`).

Expect the page to show a short "setting up your workbench" wait while
`/complete-setup` polls, then land on a "Your first routines are running"
screen listing each routine as confirmed running with your credential, and
a "Meet Myra" button into the bench itself.

### Publishing the corbits-tools registry

The **assistant** default workflow pins the `@corbits/memory-tools` tool
package (`workflows/assistant/src/index.ts`), and that pin only resolves
once a `package-registry`-kind asset named `corbits-tools` carries its
tarball (see `apps/hub/src/index.ts`'s `CORBITS_TOOLS_REGISTRY` comment).
`seedTenant` (`packages/hub-client/src/seed.ts`) publishes that asset
itself — via `@corbits/tool-registry-publish`, which bundles
`@corbits/memory-tools` into a self-contained tarball (every dependency
inlined, so the closure resolver has nothing further to fetch) and pushes
it through the hub's native asset REST routes — ahead of deploying any
workflow, so this step needs nothing from you: **echo**, **workbench-digest**,
**assistant**, and **recurring-task** all come up live.
`scripts/e2e/local-rip.test.ts` asserts exactly that.

## 5. Check the Connections surface

Back in Settings → Connections, the provider you connected shows as
`connected`, cross-referenced from your tenant's own credentials list
(`GET /api/tenants/:id/credentials`) the same way
`packages/settings-ui/src/connections-status.ts`'s `connectorStatus`
does — the credential named `<provider>-default`
(`inferenceCredentialName`, `packages/hub-client/src/seed.ts`), `status:
"active"`.

That's the onboard → connect leg, proven with your own real key end to
end.

## 6. Dispatch a task

Press Cmd/Ctrl+T (or the "New task" control in the shell) to open the task
composer (`TaskComposerDialog`, `packages/tasks-ui`). It offers two ways to
pick who does the work (`createMyraAgentSelectionStrategy`,
`packages/tasks-ui/src/myra-agent-selection-strategy.tsx`):

- **Choose an agent yourself** — pick a taskable agent from the manual list
  (**echo** is always available) and send it a prompt. This calls the real
  `@corbits/tasks` HTTP surface (`packages/tasks/src/routes.ts`):
  `POST /api/tenants/:id/tasks` launches a one-shot folded run with no
  workbench involved (`launchTask`, `packages/tasks/src/launcher.ts` — the
  run's own `workflowRun` id comes from `@intx/hub-common`'s `generateId`,
  mirroring `@corbits/chat`'s own invite-launch shape).
- **Let Myra choose** (the composer's default) — type an outcome instead of
  picking an agent, and Myra turns it into a plan herself:
  `POST /api/tenants/:id/planner` (`dispatchPlanner`,
  `packages/tasks-ui/src/api.ts`, mounted by
  `@corbits/task-planner`'s `createPlannerRoutes`). Server-side, Myra's own
  one-shot run (`runOneShotFoldedPrompt`, `@corbits/folded-runs`) turns
  your outcome plus the tenant's real inventory of agents/tools/skills into
  a `TaskSpec` (`packages/task-planner/src/planner-run.ts`), which then
  dispatches exactly like a manually-launched task — a real task row, and
  (for a plan that names a brand-new agent) a freshly deployed agent
  definition. Any failure along that path — Myra unavailable, her reply
  timing out or unparseable, a plan referencing something outside the
  inventory, a denied create grant — reads back as one honest `422
planning_failed` response, never a partially-trusted plan
  (`isPlanningFailure`, `packages/task-planner/src/routes.ts`).
  `scripts/e2e/local-rip.test.ts`'s planner leg proves the fail-closed
  half of this against the suite's stub credential (Myra's own call to
  the real Anthropic host draws the same real 401 the task leg does, which
  can never parse as a `TaskSpec`) — swap in your own real key, as this
  walkthrough does, and the identical route instead returns a real plan
  and a real dispatch.

The task starts `running` immediately — the HTTP response only proves the
opening prompt reached the agent's session, not that its turn finished.
Watch your Inbox: once the run's own bracket closes, `@corbits/tasks`'s
orchestrator (`packages/tasks/src/orchestrator.ts`, subscribed to the
sidecar's `agent.event` stream for the process's lifetime) delivers a
single terminal item — subject `"<agent>" finished your task`, with the
agent's reply (or an honest error report if the turn couldn't complete)
as its body, and `refs` naming the task and its run
(`{kind:"task",id}`/`{kind:"run",id}`, `packages/notify/src/render.ts`).
Delivery is idempotent by construction: the store-level guard behind
`completeTask` (`orchestrator.ts`'s `deliverTerminalTask`) only lets the
caller that wins the running→terminal flip send mail, so a redelivered
terminal event can never double-post.

Tasks are personal: `GET /api/tenants/:id/tasks/:id` 404s for anyone but
the principal who created it — a same-workbench colleague's task reads as
absent, never as forbidden, so the response never leaks that it exists
(`packages/tasks/src/routes.ts`).

`scripts/e2e/local-rip.test.ts`'s task leg proves this whole path against
a real hub, sidecar, and Postgres — creation, the terminal poll, exactly-
once inbox delivery with the matching run ref, and the creator-only 404.
It launches against the tenant's already-seeded **echo** agent using the
suite's own stub credential (see that file's header comment), so its own
terminal outcome is a task marked `"done"` whose delivered body honestly
reports the stub key's real 401 against the real Anthropic host, rather
than a reply — swap in your own real key, as this walkthrough does, and
the identical path completes with a real reply instead.

**Operational note:** unlike the rest of this suite, the task leg makes a
real outbound call to `api.anthropic.com` (like `scripts/e2e/chat.test.ts`'s
echo-invite test before it — both skip `harness.ts`'s
`assertNeverRealProvider` guard on purpose, and say so inline). If this
leg fails in CI, first rule out third-party network/provider behavior
before suspecting the platform: the fast-fail shape it depends on is the
real host answering the stub key with a `401` (or `403` — Anthropic could
shift which code it uses for an invalid key), which
`@intx/inference/src/errors.ts` classifies `credential_failure`, a
category the retry policy never retries. A hang, a timeout, or a
different status code the assertion doesn't recognize points at the
provider or the network path, not at `@corbits/tasks`.

## 7. Read the trace

Once the task's Inbox item lands, its detail view offers a "View run
trace" button (`apps/web/src/pages/inbox-page.tsx`) that navigates to
`/insights/runs/:runId` — the same target `InsightsLanding`'s own run rows
open into. That page (`InsightsRunDetailRoute`,
`apps/web/src/pages/insights-page.tsx`) reads
`GET /api/tenants/:id/insights/runs/:runId/trace`
(`packages/insights/src/routes.ts`, `insightsRunTracePath` in
`apps/web/src/insights-api.ts`), served off the platform's own
`inference_turn`/`turn_part` rows — no separate tracing store
(`createDrizzleRunTraceReader`, `packages/insights/src/trace-reader.ts`).
One span per turn the run took, with tool-call and error sub-spans nested
under it; a run outside your tenant, or that never existed, reads back as
`404`, never a fabricated empty trace.

A dispatched task's run is deliberately absent from the Insights landing
page's own top-level feed (`GET /api/tenants/:id/top-level-runs`,
`packages/folded-runs/src/scope-routes.ts`) — that feed is scoped to
genuine top-level deployments (workbenches, scheduled routines), and a task
is folded-run plumbing the same way an invited workbench participant is
(`launchTask` shares `launchFoldedRun` with `@corbits/chat`'s own invite
path, which is what plants the marker this scoping query excludes on).
The trace link is the one path back to a task's own run detail.
`scripts/e2e/local-rip.test.ts`'s trace leg proves both halves of this
against the same real run: the trace route resolves it with real span
rows, and the top-level-runs listing never surfaces it.

## 8. Turn it into a routine

A completed task's Inbox item also offers a "Make this a routine" button
(`apps/web/src/pages/inbox-page.tsx`, shown once `status === "done"`),
which opens the Routines page's create dialog prefilled with that task's
agent and prompt, targeting the tenant's already-deployed
**recurring-task** definition (`RoutinePrefill`,
`apps/web/src/routine-prefill.ts`) — the same definition step 4 deployed
for you, never run directly on its own. Saving that dialog schedules a
routine that dispatches through the same `launchTask` a manual task does
(`apps/hub/src/routine-launcher.ts`), delivering to your Inbox on the same
schedule, never a workbench. `scripts/e2e/recurring-task-routine.test.ts`
proves the scheduled-fire path end to end against a real hub, sidecar, and
Postgres: a routine with no delivery workbench at all, a forced-due fire
that dispatches a real task rather than a folded run of its own, and that
task's terminal delivery landing in the routine creator's Inbox.
