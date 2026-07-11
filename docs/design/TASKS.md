# Native Workbench Tasks — design (CL-3302)

Design deliverable for the v0.6 epic (CL-3305, pillar 6). No code ships from this
document; implementation tickets are cut from it after review.

**Recommendation in one paragraph.** Build a workbench-owned `task` table +
`packages/tasks` domain package, with a **static self-describing adapter
registry** that mirrors the existing hub tool-registry pattern
(`apps/hub/src/lib/tool-registry.ts`) — a hand-merged, name-keyed map of adapter
descriptors, not a dynamic plugin system and not hardcoded per-system branches.
Sync is **one-way push, gated behind explicit approval or the autonomy setting,
v1 Attio only**, reusing the two write tools that already exist in
`packages/tools-attio` with their marker-based idempotency. Tasks surface in the
/inbox page and the notifications bell, are created by the ephemeral mailbox-Myra
triage session through hub-backed `task_*` tools, and register their toggles in
the CL-3309 settings registry.

---

## 1. Task model

### Where it lives

- Schema: exported arktype in `packages/workbench-shared/src/tasks.ts` (the
  boundary shape, per the arktype canonical-form rule in `AGENTS.md`).
- Domain logic (status machine, adapter registry, sync planning):
  `packages/tasks` (new). Apps stay thin hosts.
- Table: `task` in `apps/hub/src/db/schema.ts`, following the `artifact` /
  `memory` conventions verified there: `uuid("id").primaryKey().defaultRandom()`
  (workbench rows do not use `@intx/hub-common` `generateId` — that is for
  Interchange entities; see `artifact` at `schema.ts:264-291` and `memory` at
  `schema.ts:296-315`), `text` columns holding Interchange principal/tenant ids
  by value with no FK, `createdAt`/`updatedAt` with `$onUpdate`.

### Proposed schema

```ts
// packages/workbench-shared/src/tasks.ts
export const taskStatuses = [
  "open",        // created, nothing working it
  "in_progress", // a human or agent has picked it up
  "waiting",     // blocked on someone/something else (external reply, a gate)
  "done",
  "cancelled",
] as const;
export const TaskStatusSchema = type.enumerated(...taskStatuses);

export const taskSources = ["mail", "workflow", "agent", "user"] as const;
export const TaskSourceSchema = type.enumerated(...taskSources);

export const TaskLinkSchema = type({
  kind: "'artifact' | 'workflow_run' | 'mail' | 'conversation' | 'url'",
  ref: "string",          // artifact id, run id, mailbox item id, or URL
  "label?": "string",
});

export const TaskExternalRefSchema = type({
  adapterId: "string",     // registry key, e.g. "attio"
  externalId: "string",    // the downstream system's id (Attio task_id, Linear issue id, …)
  "externalUrl?": "string",
  syncState: "'pending' | 'synced' | 'detached'",
  "lastSyncedAt?": "string",
});

export const TaskSchema = type({
  id: "string",
  tenantId: "string",
  ownerPrincipalId: "string",       // whose task this is (member principal)
  createdByPrincipalId: "string",   // actor that created it (human or agent principal)
  title: "string",
  "body?": "string",
  status: TaskStatusSchema,
  source: TaskSourceSchema,
  "sourceRef?": "string",           // mail item id / run id / instance id behind `source`
  "due?": "string",                 // ISO date-time
  links: TaskLinkSchema.array(),
  externalRefs: TaskExternalRefSchema.array(),
  createdAt: "string",
  updatedAt: "string",
});
export type Task = typeof TaskSchema.infer;
```

### Table mapping

One `task` table (columns mirror the schema; `links` as jsonb) plus one
`task_external_ref` table rather than a jsonb array:

| `task_external_ref` column | why a table, not jsonb |
| -- | -- |
| `taskId` (uuid FK, cascade) | one task ↔ many systems |
| `adapterId` (text) | unique `(taskId, adapterId)` — one ref per system per task, the idempotency backstop for create |
| `externalId`, `externalUrl` (text) | lookup by externalId is needed for future sync-back; jsonb can't index it cleanly |
| `syncState` (text enum), `lastSyncedAt` | reconciler queries `where syncState = 'pending'` |
| `actorPrincipalId` (text) | attribution: who caused the external write (§3) |

Indexes: `(tenantId, ownerPrincipalId, status)` on `task` (the inbox query),
unique `(taskId, adapterId)` on `task_external_ref`.

### Status vocabulary — why these five

- **Justification for small + flat:** the artifact table proves the house style
  — `artifactStatus = ["draft","approved","rejected"]` (`schema.ts:26`), pg
  `text` with enum, growth handled at the application edge. Every downstream
  system's states (Attio `is_completed` boolean, Linear's workflow states,
  GitHub open/closed) must map onto ours, so the native vocabulary must be the
  *lowest common denominator*, not a union. Five states is the smallest set
  that distinguishes "someone should look at this" (`open`), "being worked"
  (`in_progress`), "parked, don't nag" (`waiting`), and the two terminals.
- `waiting` earns its place because the epic's whole point is agent-prepared
  work parked on human input (prepare-only autonomy, CL-3304) — the inbox must
  be able to show "waiting on you" distinctly from "open".
- Deliberately **no** `failed` status: a task never fails, an *operation on it*
  can. Failure lives on `task_external_ref.syncState` / logs, never as a
  user-facing task state (house rule: never surface failure counts).
- Per-adapter richer states map through the adapter's `mapStatus` (§2), e.g.
  Attio: `done` → `attio_update_task { isCompleted: true }`; everything
  non-terminal → open.

### Relationship to Artifact — why Task is not an artifact kind

`artifact` is content-with-versions (`content: text` mandatory, append-only
`artifact_version` history, `draft/approved/rejected` lifecycle —
`schema.ts:264-341`). A task is a *pointer to work* with a state machine and
external mirrors; it has no content body to version and its status vocabulary
is disjoint. Wedging it in as `kind: "task"` would abuse `content`, drag along
version rows nobody wants, and make the sync reconciler query artifacts. A task
*links to* artifacts (`links[].kind: "artifact"`) — same relationship a
workflow run has.

---

## 2. Adapter registry

### The two options, honestly

**Option A — hardcoded per-system paths.** An `if (system === "attio")` branch
in a hub sync service calling `tools-attio` directly. Cheapest possible v1:
one adapter, one call site, no abstraction to design. Costs: the branch lives
in `apps/hub`, which violates the "apps stay generic; packages own the domain"
rule from day one; every later system (Linear is effectively already requested
— the epic names five) reopens the hub service, the settings UI, and the
Owner credential UI with bespoke wiring; and there is no single place the
product can ask "which systems can this task go to, and is the credential
configured?" — the Tools gallery had exactly this problem and solved it with
`providerAvailable` against the registry (`apps/hub/src/lib/tenant-tools.ts:65`).

**Option B — self-describing static registry.** Each adapter is a descriptor
in a name-keyed map inside `packages/tasks`; the hub consumes the merged map
generically. This is not speculative architecture — it is the **already-proven
house pattern**, verbatim:

- Tool packages export a name-keyed map of `{ definition, providerName,
  createTools }` (`GAMMA_HUB_TOOLS`, `packages/tools-gamma/src/index.ts:65-86`;
  `ATTIO_HUB_TOOLS`, `packages/tools-attio/src/index.ts:897-961`).
- The hub merges them into one flat `KNOWN_TOOLS` and discriminates entry
  kinds structurally (`isCredentialToolEntry`,
  `apps/hub/src/lib/tool-registry.ts:87-125`).
- Credentials resolve at execution time from the entry's `providerName` via
  `resolveCredentialRequirement(db, tenantId, { providerName, source:
  "tenant" }, null, null)` (`apps/hub/src/lib/run-credential-tool.ts:12-56`).
- The Owner UI knows about a provider through the hand-maintained
  `CREDENTIAL_PROVIDER_CATALOG` (`packages/workbench-shared/src/governance.ts:427-533`),
  kept honest by a seed-credentials test.

**Recommendation: Option B**, with the explicit caveat that "registry" means a
*static, hand-merged record* — no dynamic discovery, no DB-registered adapters,
no plugin loading. The marginal cost over Option A is one interface and one
map, because every hard part (credential resolution, catalog surfacing,
availability checks) is reused, not built. What it buys immediately: adapter
availability drives the UI generically ("Send to Attio" appears only when the
`attio` credential resolves), the settings page and triage tools enumerate
adapters without knowing their names, and Linear/GitHub/Slack later are one
file + one registry line + one catalog line each. If we ship Option A we will
rewrite it as Option B on adapter #2; the epic already commits us to adapter #2.

### Adapter contract

```ts
// packages/tasks/src/adapter.ts
export const taskAdapterOperations = [
  "create",     // mirror a native task into the system
  "update",     // push title/body/due changes
  "close",      // push terminal status
  "comment",    // attach a note/comment to the external object
  "sync_back",  // poll external state into the native task (v2, declared now)
] as const;
export const TaskAdapterOperationSchema = type.enumerated(...taskAdapterOperations);

export const TaskAdapterDescriptorSchema = type({
  id: "string",                     // registry key + task_external_ref.adapterId, e.g. "attio"
  label: "string",                  // "Attio"
  providerName: "string",           // credential provider (resolveCredentialRequirement)
  operations: TaskAdapterOperationSchema.array(),
  externalRef: {                    // self-described ref shape, for UI + validation
    idLabel: "string",              // "Attio task"
    "urlTemplate?": "string",       // how to render a deep link from externalId
  },
});
export type TaskAdapterDescriptor = typeof TaskAdapterDescriptorSchema.infer;

// The executable half — plain type: functions can't be arktype
// (same convention as the fetcher intersection rule in AGENTS.md).
export type TaskAdapter = TaskAdapterDescriptor & {
  execute: (
    op: Exclude<TaskAdapterOperation, "sync_back">,
    input: TaskPushInput,           // task snapshot + existing externalRef + idempotencyKey
    config: { apiKey: string; baseURL: string },
  ) => Promise<TaskPushResult>;     // { externalId, externalUrl?, deduped: boolean }
};

export const TASK_ADAPTERS: Record<string, TaskAdapter> = {
  attio: attioTaskAdapter,          // v1: the only entry
};
```

Registration = add one entry to `TASK_ADAPTERS`, one `buildEntries()` seed
entry if the provider is new (`apps/hub/bin/seed-credentials.ts:81-344`), and
one `CREDENTIAL_PROVIDER_CATALOG` line — exactly the existing new-tool
checklist from `AGENTS.md` § Credential Seeding Maintenance. No core change.
Note Attio needs **none of the credential steps**: provider `attio` is already
seeded (`seed-credentials.ts:291-298`) and cataloged (`governance.ts:495-499`).

The v1 Attio adapter's `execute` delegates to the existing handlers in
`packages/tools-attio`: `create`/`comment` → `attio_create_note` (which already
implements marker-based idempotency: it preflights for a hidden
`<!-- idem:${key} -->` marker and returns `{ deduped: true }` instead of
double-posting — `packages/tools-attio/src/index.ts:438-490`), `close`/`update`
→ `attio_update_task` (`index.ts:358`). Both are fatal-on-non-2xx via
`fetchAttioJSON` (`index.ts:105-133`), which the sync layer relies on (§3).

---

## 3. Sync semantics

### One-way push in v1 — and what "push" means

v1 is **native → external only**, and only on explicit action: the user clicks
"Send to Attio" (or an agent proposes it and the user approves, or the user's
autonomy setting is execute-with-gates and a gate approved it). No background
mirroring of every native task, no webhooks, no polling. Rationale: the
attio-task-agent proved that a human-approved, note-first write-back is what
users trust (`workflows/attio-task-agent/src/index.ts:100-107` documents the
ordering rationale; the `approveSync → syncGate → writeNote → writeComplete`
tail at `index.ts:260-306`); bidirectional sync multiplies failure modes
(conflicts, loops, deletion semantics) before we know tasks are used.
`sync_back` is declared in the operations vocabulary now so the descriptor
shape doesn't change when v2 adds a poll-based reconciler.

### Idempotency

Two layers, both already proven in this codebase:

1. **Registry-level:** unique `(taskId, adapterId)` on `task_external_ref`. A
   `create` first inserts the ref row with `syncState: 'pending'`; a second
   concurrent create for the same pair fails the unique constraint loudly
   (same backstop technique as `artifact_version`'s
   `(artifactId, version)` unique, `schema.ts:335-340`).
2. **Wire-level:** the idempotency key passed to the adapter is
   `task:<taskId>:<operation>`. The Attio adapter forwards it to
   `attio_create_note`'s existing marker dedupe, so even a retry after a lost
   response cannot double-post (the tool returns `{ deduped: true }`).
   Update/close are naturally idempotent (PATCH to an absolute state).

### Attribution

Every external write is attributed to a principal, per the universal-attribution
rule: the push path requires an `actorPrincipalId` (the human who clicked, or
the agent principal whose gate-approved plan fired), stores it on the
`task_external_ref` row, and the sync service writes an `admin_audit`-style
record only if we later need cross-principal review (the existing `admin_audit`
table, `schema.ts:522-540`, is the template — v1 keeps attribution on the ref
row and defers a dedicated audit table). Where the external system supports
actor identity (Attio does not for API-key writes), the adapter includes the
actor in the payload body instead (the attio-task-agent already writes
provenance into the note content).

### Failure handling

- A push failure (adapter throws — remember `fetchAttioJSON` is fatal on
  non-2xx) leaves `syncState: 'pending'` and records the error server-side
  (`@intx/log` + Sentry). A bounded reconciler retries pending refs with
  backoff; after the retry budget it stops retrying and leaves the ref
  `pending`.
- **User-facing UI never shows an error state or a failure count** (house
  rule). The task card shows the external chip in exactly two user-visible
  states: linked (deep link via `urlTemplate`) or "sending…" (pending).
  A pending-forever ref simply keeps offering the send affordance; operators
  see the truth in logs/Sentry.
- `detached` covers the user explicitly unlinking, so a re-send creates a new
  external object intentionally rather than reviving a stale ref.

---

## 4. Surfaces

### /inbox page and the bell

The inbox and bell are greenfield today — verified: no inbox/mailbox/
notification route exists in `apps/hub/src/routes` and no such page in
`apps/web/src/pages`. The mailbox spine is CL-2607/CL-2608 (hub-readable mail
via the decided `principal_mailbox` architecture in the epic) and the page is
CL-2610; the bell is CL-3308. Tasks integrate as a **read model beside mail,
not inside it**:

- `GET /me/tasks` on the authenticated v1 app, caller resolved with the
  `getRootTenantId` + `lookupMember` pattern (`apps/hub/src/routes/me-preferences.ts:39-49`
  — the "strictly caller-owned" resolution, correct here because the inbox
  shows *your* tasks), filtered `ownerPrincipalId = caller`, ordered by
  status-then-due. Response parsed through the shared `TaskSchema`.
- The /inbox page renders two groups from two queries: mailbox items
  (CL-2608's route) and tasks (`open`/`in_progress`/`waiting`). A mail item
  that spawned a task deep-links to it via `task.sourceRef`.
- The bell (CL-3308) is specified as feeding off "the mailbox/gate read
  models"; tasks add a third feed — new task assigned to you, task went
  `waiting` on you. Same polling/SSE mechanism the bell uses for mail; no
  task-specific transport.

### Ephemeral mailbox-Myra triage (CL-3303)

Per the epic, each external inbound mail item gets its own ephemeral Myra to
classify/plan/draft/prepare. "Prepare" needs a durable object to leave behind —
that object is a Task. Mechanism: hub-backed **context tools** `task_create`,
`task_update`, `task_list` registered in `KNOWN_TOOLS` as `ContextToolEntry`s
(the credential-less variant that receives `{ db, tenantId, … }` —
`apps/hub/src/lib/tool-registry.ts` shape; `vercel-deploy-artifact.ts` is the
context-tool precedent). The triage Myra calls `task_create({ title, body,
due?, links })`; the hub stamps `source: "mail"`, `sourceRef: <mail item id>`,
`createdByPrincipalId: <Myra's principal>`, `ownerPrincipalId: <the user>`.
Whether the triage session may also *push* the task externally is governed by
the CL-3304 autonomy setting: prepare-only (default) creates the native task
only; execute-with-gates may fire an adapter push behind an approval.

### Settings registry (CL-3309)

Task settings are registrations in the CL-3309 preferences registry (which
extends the open-map `MemberPreferences` store,
`packages/workbench-shared/src/index.ts:298-312`, persisted per
`(tenantId, memberPrincipalId)` in `member_preferences` — no migration per key):

| key | type | default | category |
| -- | -- | -- | -- |
| `tasks.triageAutoCreate` | boolean | true | Inbox |
| `tasks.defaultAdapterId` | string \| null | null | Agent |
| `tasks.notifyOnAssign` | boolean | true | Notifications |
| `tasks.notifyOnWaiting` | boolean | true | Notifications |

Per-user external identity (e.g. which Attio workspace member is "me") does
**not** go in preferences — the `member_identity` table already exists for
exactly this (`apps/hub/src/db/schema.ts:65-93`, per-member per-provider
account rows), and `MemberPreferences.attioMemberId` is the interim precedent.
Adapters read assignee mapping from `member_identity` by `provider`.

---

## 5. v1 cut

Build, in order:

1. `packages/workbench-shared/src/tasks.ts` schemas + `task` /
   `task_external_ref` tables + migration.
2. `packages/tasks` with the adapter contract, `TASK_ADAPTERS`, and the push
   service (idempotency, attribution, pending reconciler).
3. The Attio adapter wrapping `packages/tools-attio` handlers.
4. Hub: `createTasksRouter` (`GET/POST/PATCH /me/tasks`, `POST
   /me/tasks/:id/push`), `task_*` context tools in `KNOWN_TOOLS`.
5. Web: task list in the /inbox page (behind the CL-2610 shell), external-ref
   chip, send-to-adapter affordance; bell feed entries.
6. Settings registrations (after CL-3309 lands its registry).

Explicitly deferred: `sync_back`/bidirectional, Linear/GitHub/Slack/email
adapters, webhooks, a dedicated task page (inbox + a detail drawer suffice),
task assignment to other members (v1 tasks are self-owned).

### Proposed tickets (paste into Linear)

| Title | Scope (one line) |
| -- | -- |
| Tasks: shared schema + task tables and migration | `TaskSchema`/`TaskExternalRefSchema` in workbench-shared; `task` + `task_external_ref` tables with unique `(taskId, adapterId)`; migration + schema tests |
| Tasks: `packages/tasks` adapter contract and push service | `TaskAdapterDescriptorSchema`, `TASK_ADAPTERS`, push orchestration with idempotency keys, actor attribution, and the bounded pending-ref reconciler; no adapter yet |
| Tasks: Attio adapter reusing tools-attio | `attioTaskAdapter` (create/comment via `attio_create_note` marker dedupe, update/close via `attio_update_task`); assignee via `member_identity`; integration test against the real handler seam |
| Tasks: hub routes + `task_*` context tools | `createTasksRouter` on v1 (`/me/tasks` CRUD + `/push`), `task_create`/`task_update`/`task_list` as `ContextToolEntry`s in `KNOWN_TOOLS`; per-user scoping tests |
| Tasks: inbox surface + bell feed | Task group in the /inbox page, external-ref chip (linked/sending states only — no error states), send-to-adapter action, bell entries for assign/waiting |
| Tasks: triage integration + settings registrations | Wire `task_create` into the CL-3303 triage persona (source=mail, prepare-only honors CL-3304); register the four `tasks.*` settings in the CL-3309 registry |
| Tasks: docs | PRODUCT/ARCHITECTURE/IMPLEMENTATION updates via scribe; `packages/tasks` README |

Dependency notes: tickets 1–4 are independent of the mailbox spine and can
start immediately; ticket 5 needs the CL-2610 inbox shell (or ships the task
group as the page's first section); ticket 6 needs CL-3303/CL-3309.

---

## 6. Open questions for Sawyer (each with a recommendation)

1. **Is the static registry the right altitude, or do you want v1 even
   simpler (Option A)?** Recommend the registry as specced: it is one
   interface + one map on top of machinery we reuse wholesale, and the epic
   already names four more systems. Hardcoding buys almost nothing here.
2. **Task ownership: self-owned only in v1, or assignable to other members?**
   Recommend self-owned (owner = creator or triage target). Assignment drags
   in notification fan-out and permissions; nothing in the epic needs it yet.
3. **Should a workflow-created task (`source: "workflow"`) be wired into the
   existing attio-task-agent workflow now, or leave that workflow untouched?**
   Recommend leave it untouched in v1 and retire it toward tasks in v0.7 —
   its write-back tail becomes a `push` call once tasks exist, but touching a
   shipped workflow inside this cut adds risk for no new capability.
4. **Status vocabulary: is `waiting` pulling its weight, or collapse to four
   (`open/in_progress/done/cancelled`)?** Recommend keeping `waiting` — the
   prepare-only autonomy model makes "parked on a human" the single most
   important state the inbox displays.
5. **Where does the push approval live: reuse the `approval` table
   (`schema.ts:468-481`) or the awaitSignal/gate rail?** Recommend the
   `approval` table for chat-initiated pushes (it is the existing
   ask-principal rail) and the workflow gate for workflow-initiated ones —
   i.e. no new approval mechanism.
6. **Per-user Attio credentials (the CL-2695 spike had per-user OAuth) or
   tenant credential in v1?** Recommend tenant credential
   (`source: "tenant"`, the resolver default everywhere in the hub) with
   per-user identity via `member_identity`; per-user OAuth becomes an adapter
   capability flag when a system demands it.
