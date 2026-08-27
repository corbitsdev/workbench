# Architecture

This document describes how Corbits Workbench is structured, independent of
specific technology choices — see [IMPLEMENTATION.md](IMPLEMENTATION.md)
for the concrete stack.

## Repo shape

| Layer         | What lives here                                                         |
| ------------- | ----------------------------------------------------------------------- |
| `apps/`       | Deployable services: hub (API), sidecar (execution host), web (UI)      |
| `packages/`   | Domain packages — where product rules live                              |
| `workflows/`  | Workflow definition packages, deployed as assets                        |
| `vendor/intx` | Hand-copied, ledgered `@intx/*` source — see [VENDORED.md](VENDORED.md) |

Packages own product rules. Apps stay generic — they compose packages
rather than own domain logic — with one tracked exception: `apps/hub`
carries a small, explicitly-listed set of mounts (`artifacts-mount.ts`,
`memory-mount.ts`, `skills-mount.ts`, `slack-tag-mount.ts`,
`tenant-create-guard.ts`) pending extraction into packages (tracked as
CL-6127). Outside that list, a product rule that lives inside `apps/*` is
a defect — it belongs in a package.

## Interchange is the platform

Everything about identity, credentials, agent execution, and workflow
orchestration belongs to Interchange (`@intx/*`), never reimplemented in
this repo:

- **Tenancy** — the tenant hierarchy, membership, principals, roles, and
  grants (`@intx/db`, `@intx/hub-api`).
- **Credentials** — resolution and storage.
- **Agents** — launch and session orchestration (`@intx/agent`,
  `@intx/hub-agent`, `@intx/hub-sessions`).
- **Inference** — LLM calls (`@intx/inference`).
- **Workflow runtime** — definitions, runs, and the workflow host
  (`@intx/workflow`, `@intx/workflow-host`, `@intx/workflow-deploy`).
- **Mail** — the transport an agent turn uses to receive and send
  messages. A workbench itself is not a mail-holding host run.

Workbench adds product contracts on top of these primitives; it never
forks or patches Interchange internals. See [docs/TENANCY.md](docs/TENANCY.md)
for the authoritative list of what Interchange already provides versus
what is a genuine upstream gap workbench has had to work around
product-side.

## Tenancy model

A **bench** (the shared team scope) and a **workbench** (a single
conversation) are both Interchange tenants underneath — a bench is simply
a tenant nothing else is parented under as a workbench, in practice the
one a person signs into. A workbench mints its own child tenant at
creation time, parented under the bench, so its membership and grants are
native and independent of the bench's own.

Parent tenancy is largely invisible plumbing to a person using the
product: they experience "the bench" and "the workbench they're in," not
tenant ids or parent chains. Underneath, inheritance is live — plugins,
credentials, and catalog data resolve by walking the ancestor chain on
every read, never copied down at creation time. A sub-workbench or child
tenant never gets a snapshot of its parent's catalog; it always sees the
parent's current state.

See [docs/TENANCY.md](docs/TENANCY.md) for the full contract, including
the workbench-owned discriminator that distinguishes a "real" bench from a
workbench's own child tenancy (native tenants carry no `kind` field), and
[docs/GLOSSARY.md](docs/GLOSSARY.md) for the term mapping between product
nouns and platform primitives.

## Conversation as workbench data

A workbench is not a parallel messaging system bolted onto Interchange,
and it is not itself a workflow run. Creating a workbench mints a child
tenant and writes settings rows — no deploy, no host, no anchor instance
(`provisionSpaceWorkbench` and the chat create path). A workbench holds a
**timeline** of `chat.workbench_messages` rows; posting is one insert plus
one publish onto the workbench's live stream, so the conversation takes
messages whether or not any agent process is running.

A workbench's address is derived, not resolved. Asking an invited agent
for a turn is a separate act over Interchange mail; the agent replies by
emitting `connector.reply` events on its own stream, and a reply bridge
turns those events into timeline messages. See
[docs/CHAT.md](docs/CHAT.md) for the full message, thread, and
participant model. Per-workbench settings (name, participants, capacity,
connector overrides, notification prefs — see PRODUCT.md's "Workbench
settings") are composition on top of this tenant and its settings rows,
not a separate object; the surface lives in `packages/chat-ui`'s
`workbench-settings`.

**Streaming a reply.** An agent's live reply reaches the timeline through
one path, deltas to pixels:

1. Inference emits `inference.text.delta` events (vendored, `@intx/inference`)
   as an agent generates a reply, each carrying the cumulative text so far.
2. The sidecar's per-agent event stream (`SidecarRouter.subscribeAgent`,
   `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`) carries those
   events out of the run.
3. `packages/chat/src/platform-adapter.ts` subscribes to that stream and
   wraps each event as a `chat.agent` payload; `packages/chat/src/workbench-events.ts`
   merges it with in-process ephemeral events (typing, settings changes)
   onto one SSE stream, served from `GET /workbenches/:id/stream`
   (`packages/chat/src/routes.ts`), re-checking access on every delivered
   event.
4. On the web, `packages/chat-ui/src/use-workbench-stream.ts` holds the
   `EventSource` (with backoff reconnect and a polling fallback), and
   `packages/chat-ui/src/streaming-reply.ts` narrows `chat.agent` payloads
   to `inference.text.delta` and reduces them into one growing string.
5. `packages/chat-ui/src/timeline.tsx` renders that growing string as a
   synthetic in-progress message alongside the persisted timeline, until
   the real message lands and replaces it.

## Capability growth and approval gates

An agent's capability set grows through what it is granted, not through
code changes: Skills are installable, tenant- or principal-scoped
capabilities layered onto a definition or a workbench, resolved live
rather than baked in at deploy time (see `packages/skills`). Plugins are
installed globally rather than per bench or workbench (CL-6272.2). Every
external side effect — anything leaving the
platform's own boundary — sits behind a human approval gate. Approval
itself is native Interchange state (an `approval` row backed by a
`signal_correlation` row); the web client composes the names on top of it
(which agent, which bench) from the native pending-approvals list and run
view, and `@corbits/approvals` supplies the grant-allowance gate and the
human-readable headline, so a person can read what they're being asked to
approve — see [docs/needs-you.md](docs/needs-you.md).

## Sidecar allocation and the provisioner model

The **sidecar** is the execution host that runs workflow definitions on
behalf of a hub. It is a native Interchange subsystem, not a
workbench-specific service: workbench composes it the way it composes
everything else on the platform, supplying placement policy (which
sidecar a given run lands on) rather than reimplementing execution.
Provisioning and allocation follow Interchange's own contracts; workbench
does not maintain a parallel scheduler.

## Related docs

- [docs/GLOSSARY.md](docs/GLOSSARY.md) — product-term to platform-term
  mapping
- [docs/TENANCY.md](docs/TENANCY.md) — tenancy contracts and Interchange
  gaps
- [docs/CHAT.md](docs/CHAT.md) — the conversation/message/thread model
- [docs/workbench-tenancy.md](docs/workbench-tenancy.md) — workbench tenant
  mint, listing, and move mechanics
- [docs/needs-you.md](docs/needs-you.md) — the approval surfacing model
- [VENDORED.md](VENDORED.md) — the vendoring ledger for `@intx/*`

## Open questions

- Sidecar placement policy specifics (how a run is assigned to a
  particular sidecar instance under multi-sidecar deployment) are not
  detailed in the docs reviewed for this pass.
