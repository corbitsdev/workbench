# @corbits/pain-point-collateral-workflow

Turns one sales call transcript into one piece of targeted collateral,
gated behind a single human approval before anything is finalized
(CL-5995, ported from `gtm-workbench`'s `workflows/pain-point-collateral`,
child of CL-5987).

## What it does

One step, one agent, matching every other definition in this catalog.
The system prompt commits it to:

- **Intake**: the trigger names exactly two fields, either a pasted
  transcript (`transcript`) or a Granola note id (`noteId`). The model
  calls `pain_point_collateral_intake` (`./src/intake-tool.ts`) first,
  passing along whichever field it actually found — the tool
  arktype-validates both against a strict schema (rejecting anything
  malformed or unexpected, never passing raw JSON further into the run)
  and reports which one, if either, carried real content. A `noteId`
  hit is then fetched via `granola_get_note` (`@corbits/granola-tools` —
  the same package, and the same tool bundle,
  `@corbits/morning-brief-workflow` pins for its own
  `granola_list_recent_notes` call).
- **Extraction**: the customer's real pain points from the transcript —
  specific problems, not generic categories.
- **Drafting**: one piece of collateral targeted at the most significant
  pain point found.
- **Finalizing**: exactly one call to `pain_point_collateral_finalize`
  (`./src/finalize-tool.ts`), gated behind a human approval.
- **Honest failure**: one plain sentence, and stop, when a `noteId` was
  given but there is no way to fetch it (no Granola tool available, or
  the fetch fails) — never a fabricated transcript or pain points.
- **Teaching artifact on no data**: when intake reports neither field
  carried usable content, the run still calls
  `pain_point_collateral_finalize` — with a title such as "No transcript
  available", the pain point stated honestly as none found, and a body
  naming what was checked and the concrete next step (paste a
  transcript, or give a Granola note id). This persists a Library entry
  and chip instead of ending in a bare, artifact-less reply.
- **Calm denial**: one plain sentence when the collateral is not
  approved — never presented as an error.

**Teaching-artifact kind**: `outcome` (`"collateral"` | `"status-note"`)
is a required, structural argument to `pain_point_collateral_finalize`
— the model names which shape it is calling with, but never supplies
`kind` directly, so the tool (not the prompt) decides the persisted
artifact's `kind`: `"text"` for real collateral, `"status-note"` for the
no-data teaching payload above. `"status-note"` is the one
teaching-artifact kind shared by every workflow in this catalog, so the
Library's kind badge always reads "Status note" for a no-data run,
regardless of which workflow made it — never the same `"text"` kind
real collateral uses.

## Intake validation

`pain_point_collateral_intake` (`./src/intake-tool.ts`) is the one
place the trigger's two named fields are actually parsed against a
schema — an arktype object type with `"+": "reject"`, so an unexpected
field or a wrong-typed `transcript`/`noteId` comes back as an honest
`isError: true` result rather than being silently coerced or passed
through. It carries no `approval` declaration: unlike
`pain_point_collateral_finalize`, it has no external side effect, only
normalizes which of the two fields (if either) actually carried
content. Like the finalize tool, it is a workflow-local export, not a
`toolPackagePins` entry — see "Current limits" below for what that
means for deploys today.

## Approval mechanics

`pain_point_collateral_finalize` is declared `approval: "ask"`
(`@intx/agent`'s `ToolDeclaration`), the platform's native tool-approval
gate — not a workflow-DSL `awaitSignal`, and not anything invented for
this port. Calling it suspends the run: the sidecar co-writes a real
`approval` row (`vendor/intx/db/src/schema/approvals.ts`), visible in
the inbox via `@corbits/approvals`' "needs-you" list, and the run parks
until a human approves or rejects it
(`vendor/intx/inference/src/reactor.ts`). On approval the parked call
re-dispatches and the tool actually runs, exactly once. On rejection the
tool never runs at all — the model sees a synthetic "denied by approver"
error, which the system prompt turns into the calm terminal reply above.

**Inbox headline**: `@corbits/approvals`' `headlineFor` was extended
(this port's one small change to a shared package, not workflow-specific
plumbing) to prefer a tool's `description` over its bare name, and to
fold in the live call's `title` argument when present — so this
approval reads as "Finalizes one piece of pain-point sales collateral…:
'Faster onboarding for Acme Corp'" in the inbox, not the raw tool name.
Any future approval-gated tool that names its own `title` argument gets
the same richer headline for free.

**Chat approve block**: rendering the approval as an in-channel approve
block (`packages/chat/src/blocks.ts`'s `ApproveBlockData`) is not wired
today for ANY workflow in this repo — a suspended run does not yet post
a chat message announcing itself; only a completed reply turn does
(`packages/chat/src/chat-orchestrator.ts`). Building that wiring is a
platform-level change (a new listener on the `reactor.gate.blocked`
event already flowing through `SidecarEventEmitter`'s `agent.event`
stream) that touches shared chat delivery, not this one workflow — out
of scope for this port. Today, the human approves from the inbox; the
approval is real and works end-to-end there.

## Current limits (read before deploying)

One real gap stands between this definition and a fully live deploy,
platform-level, not specific to this workflow:

- **Tool-package pin resolves only once published** (CL-5999 closed the
  pinning gap; publishing is still an operator step). This definition
  pins `@corbits/granola-tools` (`PAIN_POINT_COLLATERAL_TOOL_PACKAGE_PINS`)
  for `granola_get_note`; the pin resolves at deploy time once an
  operator publishes the package to a registry the host's
  `toolPackageRegistries` config reaches — npmjs, or a `package-registry`
  asset for the `@corbits` scope (see `apps/hub/src/index.ts`'s
  `CORBITS_TOOLS_REGISTRY` wiring). The finalize tool itself persists
  for real (CL-6000): it writes through the workflow-artifacts HTTP
  surface and the finished collateral lands in the Library with a
  file-part chip in the channel.

**Library persistence is real (CL-6000).** `finalize-tool.ts`'s `run`
persists the finalized collateral via `./artifact-client.ts` against the
sanctioned workflow-artifacts HTTP surface
(`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`), authenticated
with the sidecar's own bearer token and this run's own mailbox address —
never a database handle. On success it returns the artifact's id/version;
the delivery pipeline (`packages/chat/src/artifact-delivery.ts`) turns
that into a file-part chip on the reply that finalized it. A failed
persist surfaces as an honest tool error, never a fabricated Library row.

## Usage

```ts
import {
  buildPainPointCollateralWorkflow,
  serializePainPointCollateralWorkflow,
} from "@corbits/pain-point-collateral-workflow";

const definition = buildPainPointCollateralWorkflow({
  triggerAddress: "pain-point-collateral@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300000,
});

const json = serializePainPointCollateralWorkflow(definition);
```

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable: false`
for the same reason as `collateral-generation`: its approval gate is a
poor fit for unattended scheduling.
