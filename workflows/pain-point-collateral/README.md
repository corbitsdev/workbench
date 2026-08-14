# @corbits/pain-point-collateral-workflow

Turns one sales call transcript into one piece of targeted collateral,
gated behind a single human approval before anything is finalized
(CL-5995, ported from `gtm-workbench`'s `workflows/pain-point-collateral`,
child of CL-5987).

## What it does

One step, one agent, matching every other definition in this catalog.
The system prompt commits it to:

- **Intake**, either a pasted transcript (`transcript`) or a Granola
  note id (`noteId`) fetched via `granola_get_note`
  (`@corbits/granola-tools` — the same package, and the same tool
  bundle, `@corbits/morning-brief-workflow` pins for its own
  `granola_list_recent_notes` call).
- **Extraction**: the customer's real pain points from the transcript —
  specific problems, not generic categories.
- **Drafting**: one piece of collateral targeted at the most significant
  pain point found.
- **Finalizing**: exactly one call to `pain_point_collateral_finalize`
  (`./src/finalize-tool.ts`), gated behind a human approval.
- **Honest failure**: one plain sentence, and stop, when there is no
  transcript to work from or no way to reach Granola — never a
  fabricated transcript or pain points.
- **Calm denial**: one plain sentence when the collateral is not
  approved — never presented as an error.

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

Two real gaps stand between this definition and a fully live deploy,
both platform-level, not specific to this workflow:

1. **Tool-package pin resolves only once published** (CL-5999 closed the
   pinning gap; publishing is still an operator step). This definition
   pins `@corbits/granola-tools` (`PAIN_POINT_COLLATERAL_TOOL_PACKAGE_PINS`)
   for `granola_get_note`; the pin resolves at deploy time once an
   operator publishes the package to a registry the host's
   `toolPackageRegistries` config reaches — npmjs, or a `package-registry`
   asset for the `@corbits` scope (see `apps/hub/src/index.ts`'s
   `CORBITS_TOOLS_REGISTRY` wiring).
2. **No Library-write path from a workflow tool.** Tool packages are
   materialized into the sidecar's workflow-process child, a separate
   process with no database handle and no authenticated hub-API path —
   confirmed while porting this workflow. `finalize-tool.ts`'s `run`
   builds the exact `{ title, kind, content }` payload
   `@corbits/artifacts`' `artifact_create` expects and returns it,
   `persisted: false`, rather than fabricating a Library row. The
   finalized collateral still reaches the human, in the delivered chat
   reply — it just is not yet a Library artifact with a file-part chip.

Neither gap is specific to Granola or to this workflow; both are
pre-existing platform limits this port surfaces rather than works around.

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

Registered in `@corbits/workflow-catalog` as `pain-point-collateral`
(`automatable: false` — the approval gate makes it a poor fit for
unattended scheduling, so it never appears in the Routines picker).
