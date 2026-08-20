# attio-task-agent

Works one CRM task from start to finish: reads the record and the
surrounding context, drafts what the task actually needs, and writes back
to Attio only once a human approves.

Ported from the OG gtm-workbench's `attio-task-agent` (CL-6349).

## The run

One reasoning turn with four named phases (`src/prompts.ts`):

1. **Ground yourself** — `mcp_list_servers`, `mcp_list_tools`, then
   `mcp_read` against the connected Attio server, plus any meetings or
   web-search server the workbench also has. `mcp_read` refuses any tool
   the server does not mark read-only, so "never mutate while gathering"
   is enforced by the tool, not only by the prompt.
2. **Decide what this task needs** — at most four pieces, from a fixed
   menu of kinds, each with its own quality bar.
3. **Draft and check** — write each piece in full, then read it back
   against what the task asked for.
4. **Save the work** — `attio_task_agent_finalize` once per piece
   (`approval: "ask"`), persisting it as a Library artifact.
5. **Offer the CRM write-back** — say what would be written and to which
   record, and wait. Only on a yes does it go through `mcp_call`, which
   is itself `approval: "ask"`.

## What this port changed, and why

- **Twenty-one steps folded into one.** Sixteen of the OG's steps were
  `action` or `awaitSignal` primitives. This repo's production host leaves
  `invokeAction` undefined, and a gate nobody fulfils hangs a run forever.
  The four reasoning agents (planner / executor / reviewer / suggest)
  became four phases of one prompt; the selection and clarification gates
  became the agent asking in the thread, where the person already is.
- **Attio through the MCP preset**, not a bespoke `@workbench/tools-attio`
  package — there is no native Attio tool package in this repo, and
  `@corbits/mcp-tools` is a pin a deploy here can actually resolve. One
  pin covers what the OG needed three tool packages for.
- **The write-back gate is kept, not weakened.** The OG gated on an
  explicit `confirm` signal followed by fatal write actions. Here the same
  gate is `mcp_call`'s unconditional `approval: "ask"`: the run suspends
  and a human approves the exact call before anything reaches the CRM.
- **The `gamma-presentation` draft kind is dropped.** It existed to hand
  off to a tool package this deployment does not have, and a kind nothing
  can act on is a promise the run cannot keep.

## Known gaps

- **No note idempotency.** The OG passed the task id as `writeNote`'s
  `idempotencyKey`, so re-running the same task deduped instead of adding
  a second note. `mcp_call` has no equivalent, so a re-run after a partial
  write-back can create a duplicate note. The approval gate makes this
  visible to a human before it happens, but it is not prevented.
- **No ordering guarantee across the two CRM writes.** The OG ordered
  `writeNote` before `writeComplete` so a mid-failure left the task
  visibly open rather than "done but empty". Folded into one turn, that
  ordering is the prompt's intent, not the runtime's guarantee.
- Multi-step `toolPackagePins` resolution is unproven in this repo; this
  definition is single-step, so it stays inside what the deploy path has
  actually run.

## Registration

See [`workflows/README.md`](../README.md#status-note) for what
registration/automatable/seeded mean — this one is `automatable: false`
(it starts from a specific task a person points at, and its write-back
approval is a poor fit for unattended scheduling) and not seeded by
default: it needs an Attio connection not every tenant has.
