# @corbits/morning-brief-workflow

A single mail-triggered step that pulls the sender's recent activity
across their connected sources and writes it up as one calm, scannable
daily brief. Ported from the OG gtm-workbench's `heartbeat` workflow
(CL-5993, a child of CL-5987's routines-catalog port) — renamed to
`morning-brief` because this repo's own zero-cost `heartbeat` catalog-
test fixture already owns that name for an unrelated definition.

## What it does

One step, one agent, tools arriving as packages at deploy time (never
inlined — see `test/boundary.test.ts`). The agent calls each source's
tool at most once, then writes a markdown reply with exactly three
fixed section headings, in order:

1. **What happened**
2. **What needs attention today**
3. **Suggested next actions**

## Sources: wired now, more later by design

| Source                           | Status        | Tool package                  |
| -------------------------------- | ------------- | ----------------------------- |
| Granola (recent call notes)      | wired         | `@corbits/granola-tools`      |
| Linear (recently updated issues) | wired         | `@corbits/linear-tools`       |
| Attio (CRM activity)             | not connected | no workbench tool package yet |
| Vercel (deployments)             | not connected | no workbench tool package yet |

The system prompt (`MORNING_BRIEF_SYSTEM_PROMPT`) is the single place
that owns the brief's structure and its degradation copy — the OG's
several bespoke merge/format tools (`heartbeat_merge_brief_sources`,
`heartbeat_format_brief_title`, ...) were workflow-specific, so they
are folded into this definition rather than ported as their own tool
packages. Only genuinely reusable integrations (Granola, Linear) stay
external.

Every source call degrades gracefully, never fails the run:

- A tool call that errors (missing credential, failed request) reads
  as "not connected" in the brief — the model is instructed to say so
  plainly and move on, never to fail the turn or invent activity.
- Attio and Vercel have no tool to call yet, so the prompt names them
  as "not connected" directly — an honest line, not a fabricated
  section.
- If every source is unavailable, the brief says so at the top rather
  than presenting empty or padded sections as if there were real
  content.

Adding a source later (Attio, Vercel, or a new one) means: build its
tool package, add it to `MORNING_BRIEF_TOOL_PACKAGE_PINS` in this
definition, and add one line to the prompt's source list — never
restructuring the brief.

## Usage

```ts
import {
  buildMorningBriefWorkflow,
  serializeMorningBriefWorkflow,
} from "@corbits/morning-brief-workflow";

const definition = buildMorningBriefWorkflow({
  triggerAddress: "morning-brief@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 120_000,
});

const json = serializeMorningBriefWorkflow(definition);
```

`buildMorningBriefWorkflow` bakes `@corbits/granola-tools` and
`@corbits/linear-tools` into the definition's `toolPackagePins`
(`MORNING_BRIEF_TOOL_PACKAGE_PINS` in `src/index.ts`) — there is no
separate operator step to pin them on the deployment. What still
depends on the deployer is credentials: without a real Granola or
Linear credential for the connecting tenant, each source's tool call
errors and the brief honestly reports that source as not connected
(see each package's README for its credential requirement).

## Scheduling and delivery

This package carries no schedule of its own — cadence lives on the
`@corbits/routines` Routine that launches it (`RoutineTrigger`), not on
the workflow definition. The OG ran daily at 13:00 UTC; the closest
match to its actual cadence (weekday mornings) is the cron escape
hatch, since `RoutineTrigger`'s `daily`/`weekly` presets cannot express
"every weekday":

```json
{
  "kind": "cron",
  "expression": "0 13 * * 1-5",
  "timezone": "America/Los_Angeles"
}
```

Delivery — posting the brief into a channel and/or the recipient's
inbox — is the routines layer's job too: every routine with a
`deliveryChannelId` gets a delivery thread opened before launch (the
repo's delivery invariant, `DeliveryThreadPort` in
`packages/routines/src/routes.ts`), and the launched run's reply lands
there. This workflow does not need its own persist/notify steps for
that — it only needs to reply with one clean markdown brief.

Not seeded by default (`DEFAULT_WORKFLOWS` in
`packages/hub-client/src/seed.ts`): unlike `channel-digest`, this
workflow needs real Granola/Linear credentials to be useful, so it is
a Routines-picker candidate (`corbits.workflow.automatable: true`)
rather than an every-signup default.
