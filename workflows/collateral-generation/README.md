# @corbits/collateral-generation-workflow

Drafts marketing collateral from one or more picked sources and content
types, with a swipe review on every draft and one human approval on the
final approved set (CL-5996, ported from `gtm-workbench`'s
`workflows/multi-source-collateral`, child of CL-5987).

## What it does

One step, one agent, matching every other definition in this catalog. The
system prompt commits it to:

- **Source pick**: ask which source(s) to draw from — Granola call notes
  (`granola_get_note`, `@corbits/granola-tools`), Linear issues
  (`linear_list_recent_issues`, `@corbits/linear-tools`), and/or text
  pasted directly into the conversation. Wait for an answer.
- **Content-type pick**: ask which of the seven content types to draft —
  LinkedIn post/article, Twitter/X post/article, short/mid/long blog. A
  run can draft more than one. Wait for an answer.
- **Gathering**: fetch every picked source. A source that errors is
  reported plainly and skipped, never fabricated; if nothing loads and no
  text was pasted either, the run says so and stops rather than drafting
  from nothing.
- **Drafting**: one piece per picked content type, grounded only in what
  was gathered, following that type's length/structure guidance. Public
  collateral: customer- and company-identifying detail is stripped or
  generalized. No buzzwords, no em dashes, no hollow superlatives.
- **Swipe review**: Good / Bad / Regenerate with optional feedback on
  every draft. A rejected piece gets exactly one revision; a piece
  rejected again after that is dropped, not retried.
- **Finalizing**: exactly one call to `collateral_generation_finalize`
  (`./src/finalize-tool.ts`) with every approved piece, gated behind a
  single human approval.

## Gate consolidation

`gtm-workbench`'s original implementation suspended for a human **four**
times in sequence: source pick, content-type pick, a swipe review per
drafted piece, and a second review of anything regenerated. That shape
came from the OG's step-graph architecture (`awaitSignal` steps), which
had no other way to pause for input — it was not four independent
approval decisions.

Three of those four are ordinary questions a chat-native agent asks in
the course of one conversation — what to draft from, what to draft, and
which drafts landed — not gates needing the platform's suspend/resume
approval machinery. This port keeps the same conversation shape but
**consolidates to one real approval gate**: finalizing the full set of
pieces the sender approved, all at once, in a single
`collateral_generation_finalize` call. The swipe review and its
one-revise-pass cap still happen — as regular conversational turns
before that one call, not as four separate suspended approvals.

## Approval mechanics

Identical to `@corbits/pain-point-collateral-workflow`'s
`finalize-tool.ts`: `collateral_generation_finalize` is declared
`approval: "ask"` (`@intx/agent`'s `ToolDeclaration`), the platform's
native tool-approval gate. Calling it suspends the run; a human approves
or rejects it from the inbox; on approval the tool actually runs, on
rejection it never runs and the model gets a synthetic "denied by
approver" error, which the system prompt turns into a calm terminal
reply. See that package's README for the full suspend/resume account,
which applies unchanged here.

## Current limits (read before deploying)

One real gap stands between this definition and a fully live deploy,
platform-level, not specific to this workflow:

- **No tool-package pin** (CL-5999). No production workflow builder in
  this repo threads a caller-supplied `toolPackagePins` onto a built
  definition yet. Until it lands, this definition ships with
  `tools: []`; `@corbits/granola-tools`, `@corbits/linear-tools`, and
  `@corbits/artifact-tools` all exist, are tested, and are ready to wire
  in the moment pinning is built.

**Library persistence and listing are both real (CL-6000).**
`finalize-tool.ts`'s `run` persists each approved piece via
`./artifact-client.ts` against the sanctioned workflow-artifacts HTTP
surface, sequentially — a piece that fails to persist stops the loop and
reports how many of the set already persisted, rather than silently
losing them or claiming the whole batch failed. `@corbits/artifact-tools`'
`artifact_list_recent` calls the same surface's read side, so workbench
artifacts are a real source alongside the wired Granola and Linear ones.
Delivered pieces carry their persisted artifact's file-part chip
(`packages/chat/src/artifact-delivery.ts`).

## Usage

```ts
import {
  buildCollateralGenerationWorkflow,
  serializeCollateralGenerationWorkflow,
} from "@corbits/collateral-generation-workflow";

const definition = buildCollateralGenerationWorkflow({
  triggerAddress: "collateral-generation@tenant.example",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 300000,
});

const json = serializeCollateralGenerationWorkflow(definition);
```

Registered in `@corbits/workflow-catalog` as `collateral-generation`
(`automatable: false` — on-demand only, and the approval gate makes it a
poor fit for unattended scheduling, so it never appears in the Routines
picker).
