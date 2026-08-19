# Workbench architecture: what's wrong, what Buzz does, what to build

> **Superseded in part (CL-6322).** The diagnosis, the Buzz teardown, and the
> evidence below all stand and are still the reference. The _recommendation_
> does not: sections 4-6 propose a bench event log as a new layer over the
> existing anchor-run model. The decision taken instead is **room = data,
> turn = run** — retire the workbench anchor entirely, which makes most of
> that layer unnecessary. See CL-6322 and its attached plan of attack.

A decision memo. Three symptoms — workbenches feel slow, they feel laggy,
and nobody can tell whether multi-agent actually worked — are three
different causes at three different layers. This walks the evidence, reads
Block's [Buzz](https://github.com/block/buzz) as the closest prior art,
inventories what Interchange already offers, and puts three architectures
side by side with a staged recommendation.

## 1. What is actually wrong

### Laggy: the live stream carries pings, not data

`packages/chat-ui/src/use-workbench-stream.ts:133-137` states the design
outright: `chat.agent` "is what makes a connected stream refresh the
timeline at all." Every server event triggers a refetch rather than
delivering the change.

One send, from a real request log:

```
19:30:13.960  POST .../messages                201  28ms
19:30:13.982  PUT  .../read-state              200  15ms
19:30:14.222  GET  .../pins                    200   9ms
19:30:14.225  GET  .../threads                 200  12ms
19:30:14.230  GET  .../messages                200  18ms
19:30:14.242  PUT  .../read-state              200   5ms
```

Six requests to show one message the client already had in hand. Every
agent event repeats the pattern. Two more taxes ride along: duplicate
identical fetches in the same millisecond (`providers?inherited=false`
twice, `mcp-servers` three times) from double-mounted hooks with no
dedupe, and presence maintained by `POST /presence/rooms/:room/heartbeat`
every 15 seconds per client with `provider-health` polled every 30.

Nothing here is a slow query — every response is under 30ms. The read path
is just built to re-derive instead of receive.

### Slow: a message costs a deploy

A message travels hub → mail → sidecar → agent → reply-bridge → hub. Each
participant that isn't resident pays a full `deployAtHead` before it can
hear anything (`packages/chat/src/platform-adapter.ts:324-383`). The
durable envelope is MIME plus a PGP detached signature per message; the
run's state moves as git packs over the sidecar WebSocket.

Worth killing one assumption: the git substrate is **not** the per-token
bottleneck. A full run repo holds 9 commits, and events arrive batched
("append 2 workflow events"). The cost is cold start and hop count, not
the substrate.

### Unverifiable: no per-message identity

One workbench is one immortal run. Every message, tool call, and reply
interleaves in that single run's event log. To answer "why did this bench
die" earlier today, the only available method was reading
`.data/sidecar/workflow-runs/<id>/runs/<id>/events.jsonl` off disk by
hand.

Interchange ships `run-view.ts`, `run-events-view.ts`, and
`observability.ts` in `hub-api/src/routes/`. Nothing in this repo consumes
any of them.

### The structural knot underneath

Two properties combine into the failure class we hit today:

1. **Bench identity is fused to run identity.** `platform-adapter.ts:618`
   resolves a workbench by `findFoldedRunById(deps.db, input.workbenchId)`
   — the workbench id _is_ the run id. That comes from self-anchoring
   (`packages/folded-runs/src/launch.ts:440-473`, tagged `[Intx gap]
CL-6044`): a folded run sets `anchorRunId` to its own id because
   `receiveWorkflowRunPack` refuses packs from a row that doesn't look
   like a deployment anchor.

2. **Failure granularity is the whole run.** `workflow/src/runtime/run.ts:1448`
   — an unbounded step whose turn exhausts retries throws, ending the run.
   `run.ts:2083` — an `onTrigger` body child that fails ends the section
   run: _"Terminal-is-final … the run does not relaunch."_

So one bad message kills a bench permanently, and because identity is
fused, the bench cannot be given a new host. That is exactly what happened
to `run_26da93eb…`: an event-only mail (empty text part, JSON attachment)
resumed the parked anchor with `""`, `agent.send` threw on empty content,
`StepFailed(retriesExhausted)` → `RunFailed`, 676ms after the run started.
Every later chat message then mailed a terminal run.

## 2. How Buzz works

[Buzz](https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together)
is Block's open-source humans-and-agents workspace, Apache-2.0, built on
Nostr. Six mechanics matter here.

**One signed event log is the source of truth.** Every message, reaction,
workflow step, review approval, and git event is a signed event in one
log. The relay is the only path: "no peer-to-peer event exchange, no
gossip, no replication."

**Kind numbers are the dispatch switch.** Each event carries a `kind`
integer. "Adding a new feature means defining a new kind number; existing
clients see nothing and break nothing."

**Clients subscribe with filters and receive the data.** The relay's
`SubscriptionRegistry` indexes subscriptions three ways —
`(channel_id, kind)` for O(1) exact match, `channel_id` wildcard, then
global — and fans out matching events over WebSocket. Multi-node
propagation goes through Redis pub/sub with local-echo dedupe. A client
never refetches to learn what changed.

**Ephemeral kinds never touch storage.** Kinds 20000–29999 (typing,
presence heartbeat) fan out through the same subscriptions but skip both
the database and the audit log — "enabling real-time collaboration without
bloat."

**Threads are parent references, not objects.** A reply tags its ancestor
(`["e", "<event-id>"]`); a thread is a filter query
(`{"kinds":[9],"#e":["<parent-id>"]}`). No separate thread entity, no
separate execution.

**Agents are ordinary clients, and the harness owns turn-taking.** Agents
authenticate the same way humans do, subscribe with the same filters, and
get no special server path — "scoped identity, not permission flags." The
decision to _prompt a model_ lives in the harness (`buzz-acp`): when an
agent is `@mention`ed, the event is queued per channel, and "at most one
prompt is in-flight per channel; subsequent @mentions queue until the
agent responds," with multiple mentions batched into a single prompt.

That last one answers the multi-agent question directly. Everyone hears
everything because everyone is subscribed; nobody pile-ons because the
harness serializes prompts per room. It's "everyone reads, one speaks"
implemented at the agent, not enforced by the room.

### Buzz vs workbench, honestly

|                     | Buzz                                            | Workbench today                              |
| ------------------- | ----------------------------------------------- | -------------------------------------------- |
| Source of truth     | one append-only event log                       | `session_mail` + chat projection tables      |
| Delivery to clients | subscription fan-out, carries data              | SSE ping → 4-6 refetches                     |
| Typing / presence   | ephemeral kinds, never stored                   | HTTP heartbeat every 15s                     |
| Agent connection    | long-lived subscribed client                    | deployed run, woken per message              |
| Turn-taking         | harness queue, one prompt in flight per channel | host-routes unmentioned, fan-out per mention |
| Threads             | parent tag, queryable                           | own tables, no execution identity            |
| Extensibility       | new kind number                                 | new route + client change                    |
| Per-message trace   | every step is an event in the log               | interleaved in one immortal run              |

Two things Buzz does _not_ solve for us, and which we should not copy
away: Interchange's credential resolution and approval gating are real
assets, and Buzz's Nostr keypair-per-participant model is a different
identity story than tenants and grants. The lesson to take is the
**transport and turn-taking shape**, not the identity substrate.

## 3. What Interchange already gives us

Used today: agents, inference, credentials, grants/authz, approvals,
mail bus, git-backed run state, workflow state machine, sidecar
allocation.

Available and unused:

- **`onTrigger` sections** (`workflow/src/definition/primitives.ts:210-237`)
  — a long-lived section that runs a body sub-DAG "once per occurrence of
  that trigger, each occurrence a separate child run of `body` (own run
  id, own event log), all WITHIN the one living workflow run." Per-message
  runs, which is the observability primitive we're missing. The sidecar
  already wires `spawnSuspendableChild`
  (`apps/sidecar/src/workflow-substrate-factory/index.ts:601`). Chat was
  built this way once (`3ae984f3`) and moved off it in `0daf6bcf` to kill
  a relay DAG, not because the primitive was wrong.
- **Run views and observability routes** — `run-view.ts`,
  `run-events-view.ts`, `observability.ts`.
- **Non-fatal edges as an established pattern** — `loop` has
  `onExhausted`, `gate` has `else`, `awaitSignal` has `onTimeout`.
  Long-lived sections simply never got one.

What Interchange does not offer, and won't without upstream work:

- A subscription/fan-out plane that delivers conversation data to
  browsers. Its wire is hub↔sidecar, not hub↔client.
- An ephemeral event tier (typing, presence, token deltas).
- Failure containment per message.
- Any notion of a room whose membership spans humans and many agents;
  mail is point-to-point, and fan-out is workbench's own loop.

## 4. Three architectures

### Option 1 — Bench event log, mail as transport

**What.** A workbench-owned append-only event log (`kind`, `workbench_id`,
`thread_id`, `parent_id`, `payload`, `run_id`) plus a fan-out service and
one subscribe endpoint that streams events _with payloads_. Writes append
to the log first — instant echo — then dispatch to participants over
Interchange mail asynchronously. Agent token deltas stream as ephemeral
kinds that are never stored. Threads become a parent reference on the
event. Presence and typing move to ephemeral kinds and stop hitting
Postgres.

**Why.** It fixes all three symptoms with one mechanism. Local echo and
token streaming become natural rather than bolted on; the four-to-six
refetches per event disappear; `run_id` on every event turns
"did multi-agent work" into a query. Interchange keeps everything it is
good at — agents, inference, credentials, approvals — and stops being
asked to be a browser transport, which it never claimed to be.

**How.** New package `@corbits/bench-log`: schema, kind registry, append
API, in-process fan-out (Redis later, only when multi-node), and a
`GET /workbenches/:id/subscribe` stream. `packages/chat` writes through
it instead of writing tables directly. `chat-ui` consumes typed events and
stops refetching. The reply bridge publishes deltas as ephemeral kinds.
Existing chat tables become projections rebuilt from the log.

**Cost / risk.** The largest new surface workbench would own — but
incremental, and each stage ships alone. The real risk is two sources of
truth: the log must be authoritative and mail must become a dispatch
detail, or we get drift. Mitigation: the log is the only write path from
day one.

### Option 2 — Stay inside Interchange

**What.** Adopt `onTrigger` for per-message child runs, consume the run
and observability routes, forward existing agent-event payloads through
SSE instead of pinging, dedupe client fetches, pre-warm participants, add
the non-fatal failure edge.

**Why.** Least code owned here; gaps go upstream where other builds
benefit. Genuinely fixes the unverifiable symptom and much of the laggy
one.

**How.** Rebuild the bench definition as an `onTrigger` section (deploy
materializes the body to its own asset), containment edge at
`run.ts:2083`, SSE payload forwarding, client dedupe, warm pool.

**Cost / risk.** Caps out. Mail's MIME+PGP envelope per message is a
latency floor; there is no ephemeral tier, so typing and token deltas stay
awkward; threads still have no execution identity; every new event type
needs a route plus a client change rather than a number.

### Option 3 — Fork the conversation model

**What.** A workbench becomes a first-class room with its own event log
_and_ its own agent-connection model: agents connect as persistent
subscribed clients, Buzz-style, instead of being deployed and woken per
message. Interchange supplies agent execution, inference, credentials, and
approvals only.

**Why.** Highest ceiling. Cold start disappears because agents are already
connected. Real per-thread parallelism — one in-flight prompt per (agent,
thread) rather than per bench. This is Buzz's architecture with
Interchange as the execution and credential plane.

**How.** Everything in Option 1, plus a resident agent-client host
replacing wake-per-message, and a rethink of where grants and approvals
attach when an agent is a subscriber rather than a run.

**Cost / risk.** Largest divergence. Grants, approvals, and credential
delivery all currently hang off the run; moving agents off runs means
re-seating those seams. Not a first move.

### Side by side

|                          | Option 1                                      | Option 2           | Option 3 |
| ------------------------ | --------------------------------------------- | ------------------ | -------- |
| Fixes laggy              | yes                                           | partly             | yes      |
| Fixes slow               | partly (echo + streaming; cold start remains) | partly (warm pool) | yes      |
| Fixes unverifiable       | yes                                           | yes                | yes      |
| Per-thread parallel work | yes                                           | no                 | yes      |
| New surface owned here   | medium                                        | none               | large    |
| Upstream dependency      | none                                          | high               | none     |
| Reversible               | yes, projections rebuild                      | yes                | hard     |

## 5. Recommendation

**Option 1 as the spine, staged, with Option 2's cheap wins taken first
and Option 3 kept as the direction Option 1 already points at.** Nothing
in Option 1 forecloses Option 3; Option 3 is Option 1 plus resident agent
clients.

**Stage 0 — stop the bleeding (days).** Dedupe the duplicate fetches.
Forward event payloads on the existing SSE stream and stop refetching
`pins`/`threads`/`messages` on every event. Land the failure containment
so a bad message can't kill a bench. These are independently valuable and
survive any later choice.

**Stage 1 — the log becomes the read model (1-2 weeks).** Introduce
`@corbits/bench-log`. All chat writes append; the subscribe stream carries
data; chat tables become projections. Local echo lands here.

**Stage 2 — ephemeral tier and streaming (1 week).** Typing, presence, and
token deltas as ephemeral kinds. Presence heartbeats leave Postgres.

**Stage 3 — per-message runs and turn-taking (1-2 weeks).** Every message
dispatch carries a `run_id` on its event; adopt Buzz's queueing rule
generalized to threads — one in-flight prompt per (agent, thread). Threads
get real parallel work. Observability becomes a query.

**Stage 4 — resident agents (later, optional).** Replace wake-per-message
with subscribed agent clients. Decide only once Stages 1-3 are in.

Note what this ordering makes unnecessary: the bench-identity indirection
(~150 lines and a migration) is only needed to resurrect dead benches. If
a bench can't die, it never needs resurrecting.

## 6. Open decisions

- **Threads as parallel work** was the stated intent. That means a thread
  needs turn-taking identity (Stage 3), not just a parent reference. Buzz
  queues per channel; we'd queue per (agent, thread). Confirm that's the
  semantic wanted: two agents can be mid-turn in two threads of one
  workbench simultaneously.
- **Who hears what.** Buzz's answer — everyone subscribed, harness
  serializes — is the recommendation. It costs delivering context to every
  participant agent and inference for the one that speaks.
- **Does the log replace `session_mail` as truth, or shadow it?** The memo
  assumes replace, with mail as dispatch. Shadowing is the drift risk.
- **Where per-thread grants land.** A thread with its own agent turn is
  arguably its own authorization scope. Currently grants hang off the run.
