import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  type MailboxRef,
  type TaskLink,
  adminAuditActions,
  feedbackSubjectKinds,
  taskSources,
  taskStatuses,
  taskSyncStates,
} from "@workbench/shared";

// Postgres bytea has no first-class Drizzle column helper; map it to Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const transcriptSource = ["paste", "granola", "artifact"] as const;

export const transcript = pgTable("transcript", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  source: text("source", { enum: transcriptSource }).notNull().default("paste"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Server-persisted per-member UI preferences (theme, chat display options, …).
// One row per (tenant, member principal); the `preferences` blob is an open map
// so new keys need no migration. Keyed off the user's global-org member
// principal (Interchange-owned; referenced by id only).
export const memberPreferences = pgTable(
  "member_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    memberPrincipalId: text("member_principal_id").notNull(),
    preferences: jsonb("preferences").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    memberPreferencesMemberUniq: unique(
      "member_preferences_tenant_principal_uniq",
    ).on(t.tenantId, t.memberPrincipalId),
  }),
);

// Per-member default Myra variant selection. One row per (tenant, member
// principal); each column names a variant id in the `@workbench/myra` catalog
// (validated against it at the API boundary) or NULL, which means "use the
// canonical default". A stored preference is a selection only — instances are
// minted lazily from the selected variant and keep it for life, so changing
// this never re-deploys an existing instance. Workbench-owned; no interchange
// table is touched.
// Personalization style-axis columns (CL-3760) added on the same row:
// `personality` / `emojiUse` / `uiType` are global (one value for both
// surfaces); the three usage dials are per-surface because a member may want
// e.g. heavy artifact usage in chat but none in unattended inbox automation.
// Each column holds an option id from the `@workbench/myra` style-axes
// catalog (validated against it at the API boundary) or NULL, meaning "use
// the axis's default option" — composes to no prompt overlay text.
export const myraVariantPreference = pgTable(
  "myra_variant_preference",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    memberPrincipalId: text("member_principal_id").notNull(),
    chatVariantId: text("chat_variant_id"),
    triageVariantId: text("triage_variant_id"),
    // Per-member standing guidance (CL-3661) rendered as a DATA section after
    // the operator/active-context section at prompt-build time — see
    // renderMemberInstructionsSection in @workbench/myra. `instructionsGlobal`
    // applies to every surface; `instructionsChat`/`instructionsTriage` are
    // per-surface overrides composed after it. Length-validated (4000 chars)
    // at the API boundary, not here.
    instructionsGlobal: text("instructions_global"),
    instructionsChat: text("instructions_chat"),
    instructionsTriage: text("instructions_triage"),
    personality: text("personality"),
    emojiUse: text("emoji_use"),
    uiType: text("ui_type"),
    artifactUsageChat: text("artifact_usage_chat"),
    artifactUsageTriage: text("artifact_usage_triage"),
    toolUsageChat: text("tool_usage_chat"),
    toolUsageTriage: text("tool_usage_triage"),
    skillUsageChat: text("skill_usage_chat"),
    skillUsageTriage: text("skill_usage_triage"),
    // Ordered skill asset ids pinned for Myra prompt indexing (CL-3765).
    pinnedSkillIds: jsonb("pinned_skill_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    // CL-3762: member narrowing of Myra catalog packages / tool names (never widens grants).
    disabledCatalogPackages: jsonb("disabled_catalog_packages")
      .$type<string[]>()
      .notNull()
      .default([]),
    disabledToolNames: jsonb("disabled_tool_names")
      .$type<string[]>()
      .notNull()
      .default([]),
    creativeChat: integer("creative_chat"),
    thinkingChat: integer("thinking_chat"),
    creativeTriage: integer("creative_triage"),
    thinkingTriage: integer("thinking_triage"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    myraVariantPreferenceMemberUniq: unique(
      "myra_variant_preference_tenant_principal_uniq",
    ).on(t.tenantId, t.memberPrincipalId),
  }),
);

// Per-member, per-tool account identity (CL-2420). One row per account, so a
// member can hold several accounts of the same provider (e.g. two Linear
// workspaces) — each with a human `label`, a `isPrimary` default flag, and an
// open `metadata` map. `value` is the identifier Myra passes to that tool to
// scope "my X" queries. Tool-accessed only (never dumped into the prompt).
export const memberIdentity = pgTable(
  "member_identity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    memberPrincipalId: text("member_principal_id").notNull(),
    provider: text("provider").notNull(),
    value: text("value").notNull(),
    label: text("label"),
    isPrimary: boolean("is_primary").notNull().default(false),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    memberIdentityAccountUniq: unique("member_identity_account_uniq").on(
      t.tenantId,
      t.memberPrincipalId,
      t.provider,
      t.value,
    ),
  }),
);

// Slack workspace (team) → tenant mapping (CL-3629). Written when the owner
// enables the Slack inbox source (`auth.test` on the tenant's bot token
// resolves the team id). `slackTeamId` is globally unique — resolving a
// webhook's `team_id` yields at most one tenant, so an unmapped team is
// dropped rather than fanned out across every tenant with Slack enabled.
// Assumes one signing secret (`SLACK_SIGNING_SECRET`) verifies every mapped
// team; a distributed Slack app installed to multiple workspaces shares one
// signing secret, so this holds until per-tenant secrets are needed.
export const slackTeamTenantMapping = pgTable(
  "slack_team_tenant_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slackTeamTenantMappingTeamUniq: unique(
      "slack_team_tenant_mapping_team_uniq",
    ).on(t.slackTeamId),
  }),
);

// Binary files uploaded before any workflow run exists. Artifacts require a
// sessionId (FK to workflow_run), but an xlsx arrives ahead of the run that
// will consume it (CL-1961), so uploads live in their own tenant-owned table
// and are referenced by id when the run is created.
export const upload = pgTable("upload", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  content: bytea("content").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UploadRow = typeof upload.$inferSelect;

// Per-file upload ceiling (BYTEA in the `upload` table). 10MB comfortably covers
// a product-catalog xlsx or a generated deck PDF; larger inputs are out of scope
// (object storage). Lives with the table so both the upload route and hub tools
// can share it without a route↔lib import cycle.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const workflowRun = pgTable("workflow_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Native-deploy index column (M6.8): the @intx/workflow-deploy deploymentId
  // (a `ses_…` string, not a uuid) for runs deployed through the native stack.
  // Null for legacy pipeline-session rows. The uuid `id` stays the PK so the
  // transcript FK is unaffected.
  deploymentId: text("deployment_id"),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  // Deploy-time provenance captured at deploy (CL-2321): the workflow package
  // version + short git sha + the deploy clock's timestamp. Null for older
  // deployments that predate version capture. The UI surfaces it in the "?"
  // tooltip; the projection bridge names it in the run-failed log.
  meta: jsonb("meta").$type<{
    version: string;
    sha: string;
    deployedAt: string;
    label?: string;
    description?: string;
  }>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
});

// CL-2669: thin RUN INDEX. A run's authoritative per-step and run state is read
// on demand from its native git event log (`run-state-from-log.ts`), not
// mirrored here — this row is a run-level index only: tenancy/ownership, the run
// kind, the coarse run-level `status`, and run-level timing (`startedAt` /
// `endedAt`). The former step-level mirror columns (`current_step_id`,
// `outputs`, `error`) were removed; step data now comes from the log. Distinct
// from the `workflow_run` deployment-index table, which the native-deploy path
// still owns.
export const workflowRunStateStatus = [
  // CL-2755: the initial state of a run whose per-run deployment is still being
  // provisioned off the /start critical path. Non-terminal; the projection
  // bridge folds it to `running` on the first RunStarted event, or the start
  // tail flips it to `failed` if provisioning/trigger fails.
  "provisioning",
  "running",
  "awaiting",
  "completed",
  "failed",
  // CL-3688: user-initiated stop; terminal like completed/failed but distinct from
  // operator abort / runtime failure (which stay `failed`).
  "stopped",
] as const;

export const workflowRunRecord = pgTable("workflow_run_record", {
  id: text("id").primaryKey(),
  deploymentId: text("deployment_id"),
  kind: text("kind").notNull(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  status: text("status", { enum: workflowRunStateStatus })
    .notNull()
    .default("running"),
  input: jsonb("input").$type<unknown>(),
  // Durable record of a gate signal the hub 202-accepted but whose delivery
  // is not yet proven by the run log. Written BEFORE the fire-and-forget
  // sidecar dispatch; cleared by the projection when the log folds a
  // matching SignalReceived (or the run reaches terminal). While set, the
  // reconciler re-delivers it instead of hibernating the run — the invariant
  // is that an accepted signal is eventually delivered or the run visibly
  // fails, never silently parked forever. Shape: PendingRunSignalSchema in
  // workflow-executor/run-store.ts.
  pendingSignal: jsonb("pending_signal").$type<{
    signalId: string;
    signalName: string;
    payload: unknown;
    receivedAt: string;
  } | null>(),
  // The conversation the run was started from (CL-2677); null for
  // direct-started runs with no chat context.
  originConversationId: text("origin_conversation_id"),
  // Which trigger path started the run (CL-3509): "scheduler" for a run fired by
  // an attached-workflow schedule, null for interactive/manual/webhook starts.
  // The stalled-run reconciler only fails scheduler-sourced runs parked past its
  // timeout — an interactive run legitimately waits on a human indefinitely.
  triggerSource: text("trigger_source"),
  // Run-level wall-clock timing, written by the projection bridge from the
  // log's RunStarted / terminal events (CL-2669). Not the per-step timing —
  // that stays in the log.
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at"),
});

export type WorkflowRunRecordRow = typeof workflowRunRecord.$inferSelect;

// CL-2727: per-step run state PROJECTION. Where `workflow_run_record` carries a
// run's coarse run-level status, this table mirrors the AUTHORITATIVE per-step
// state the native `@intx/workflow` state machine computes as it folds the run's
// event log (`run-state-from-log.ts` → `resumeFromLog`): one row per (run, step)
// with the step's phase, attempt count, and wall-clock timing. Written UPDATE-OR-
// INSERT by the projection bridge on every pack (idempotent — the full log folds
// to the same state), so the hub can serve per-step state + aggregate stats
// without re-reading the git log on every request. NOT a re-invented fold: the
// values come straight from the native RunState. Workbench-owned; distinct from
// both `workflow_run` (deployment index) and `workflow_run_record` (run index).
export const workflowRunStepPhases = [
  "in-flight",
  "awaiting-signal",
  "awaiting-timer",
  "completed",
  "failed",
  "cancelled",
] as const;

export const workflowRunStep = pgTable(
  "workflow_run_step",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The owning run (`workflow_run_record.id`, a text run id). Not a DB foreign
    // key — the projection bridge upserts steps for whatever run its log names,
    // and the record row is seeded independently at /start.
    runId: text("run_id").notNull(),
    stepId: text("step_id").notNull(),
    phase: text("phase", { enum: workflowRunStepPhases }).notNull(),
    // The native StepState.currentAttempt (1-based once a step has started).
    attempts: integer("attempts").notNull().default(0),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    runStepUniq: unique("workflow_run_step_run_step_uniq").on(
      t.runId,
      t.stepId,
    ),
  }),
);

export type WorkflowRunStepRow = typeof workflowRunStep.$inferSelect;

// A first-class output of any workflow or agent. `kind` is free-form text
// (validated at the application edge, not a pg enum, so kinds can grow without
// migrations). Nesting via parent_id.
export const artifact = pgTable(
  "artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id"),
    principalId: text("principal_id"),
    ownerPrincipalId: text("owner_principal_id"),
    // Null for artifacts created directly by agents via the artifact_* tools
    // or write_artifact (they are tenant/principal scoped, not workflow_run scoped).
    // Workflow paths always supply a valid id.
    parentId: uuid("parent_id").references((): AnyPgColumn => artifact.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    source: jsonb("source").$type<Record<string, unknown>>(),
    version: integer("version").notNull().default(1),
    // Soft-archive (CL-3156): null = visible, a timestamp = hidden from default
    // listings. Reversible; independent of any per-kind review state (skill
    // drafts now live as `skill-draft` assets — see @workbench/hub-sessions —
    // whose existence, not a status column, is the review state).
    archivedAt: timestamp("archived_at"),
    // Idempotency backstop for a source that can race a duplicate insert past
    // an app-level existence check (CL-3577 review fix B; extended to a
    // per-artifact-kind key and made the primary dedupe mechanism for Granola
    // call processing under CL-4213 — see granola-call-artifacts.ts). The
    // Granola pipeline sets `granola:call:<noteId>:<kind>`, one per typed
    // artifact (pain points / summary / brief). Null for every artifact
    // created through the artifact_* tools / write_artifact without a
    // sourceRef; the partial unique index only constrains rows that opt in by
    // setting this column.
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    artifactTenantSourceRefUniq: uniqueIndex("artifact_tenant_source_ref_uniq")
      .on(t.tenantId, t.sourceRef)
      .where(sql`${t.sourceRef} IS NOT NULL`),
  }),
);

// CL-2668: durable agent memory moved out of the artifact table into its own
// table. No version history — a save is a plain overwrite. One row per
// (tenant, owner) via a plain unique index (no longer scoped by kind, since
// this table holds nothing else).
export const memory = pgTable(
  "memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    ownerPrincipalId: text("owner_principal_id").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    memoryTenantOwnerUniq: uniqueIndex("memory_tenant_owner_uniq").on(
      t.tenantId,
      t.ownerPrincipalId,
    ),
  }),
);

// Append-only version history. Every change by an agent or a human writes a row.
// author_id is the actor's principal id (no agent/human distinction).
export const artifactVersion = pgTable(
  "artifact_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => artifact.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    authorId: text("author_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  // One row per (artifact, version). Backstops the version bump in
  // artifact_write: a racing writer that computes the same next version fails
  // loudly instead of corrupting history with duplicate version rows.
  (t) => ({
    artifactVersionUniq: unique("artifact_version_artifact_id_version_uniq").on(
      t.artifactId,
      t.version,
    ),
  }),
);

// Native Workbench tasks: a pointer to work with a state machine and
// downstream mirrors. Workbench-owned — text principal/tenant columns held by
// value, no FK to any interchange table. The (tenant, owner, status) index
// serves the inbox query.
export const task = pgTable(
  "task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    ownerPrincipalId: text("owner_principal_id").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    // Nullable: an unassigned task is owner-only, same as before this column
    // existed. Set/cleared via PATCH /me/tasks/:id by the task's owner.
    assigneePrincipalId: text("assignee_principal_id"),
    title: text("title").notNull(),
    body: text("body"),
    status: text("status", { enum: taskStatuses }).notNull().default("open"),
    source: text("source", { enum: taskSources }).notNull(),
    sourceRef: text("source_ref"),
    due: timestamp("due"),
    links: jsonb("links").$type<TaskLink[]>().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    taskTenantOwnerStatusIdx: index("task_tenant_owner_status_idx").on(
      t.tenantId,
      t.ownerPrincipalId,
      t.status,
    ),
    taskTenantAssigneeStatusIdx: index("task_tenant_assignee_status_idx").on(
      t.tenantId,
      t.assigneePrincipalId,
      t.status,
    ),
  }),
);

export type TaskRow = typeof task.$inferSelect;

// A task's mirror in a downstream system (Attio, ...). One row per
// (task, adapter) — the unique constraint is the create-idempotency backstop.
// `actorPrincipalId` attributes the external write; `syncState = 'pending'` is
// what the reconciler scans for. Failure detail never leaves the server.
export const taskExternalRef = pgTable(
  "task_external_ref",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    adapterId: text("adapter_id").notNull(),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    syncState: text("sync_state", { enum: taskSyncStates })
      .notNull()
      .default("pending"),
    actorPrincipalId: text("actor_principal_id").notNull(),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    taskExternalRefUniq: unique("task_external_ref_task_id_adapter_id_uniq").on(
      t.taskId,
      t.adapterId,
    ),
    taskExternalRefSyncStateIdx: index("task_external_ref_sync_state_idx").on(
      t.syncState,
    ),
  }),
);

export type TaskExternalRefRow = typeof taskExternalRef.$inferSelect;

// Tracks which workflow kinds are enabled within a tenant.
//
// Two flavours:
//   - principal_id IS NULL  → tenant-scoped row, enabled for all members.
//     Seeded by seedTenantWorkflows at workbench creation; no user action needed.
//   - principal_id NOT NULL → per-user row, enabled by an individual member.
//     Kept for backwards compatibility; per-user opt-in still works.
//
// GET /workflows/enabled returns rows matching either flavour for the caller.
// Unique on (tenant_id, principal_id, kind) for non-null rows; a separate
// partial unique index handles (tenant_id, kind) WHERE principal_id IS NULL
// (migration 0017).
export const enabledWorkflow = pgTable(
  "workbench_workflows",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id"),
    kind: text("kind").notNull(),
    // Per-step credential/tool assignments captured when the workflow is added
    // to the workbench. Shape: Record<stepName, { credentialIds: string[]; toolIds: string[] }>.
    assignments: jsonb("assignments"),
    enabledAt: timestamp("enabled_at").notNull().defaultNow(),
  },
  (t) => ({
    tenantPrincipalKindUniq: unique(
      "workbench_workflows_tenant_principal_kind_uniq",
    ).on(t.tenantId, t.principalId, t.kind),
  }),
);

// Per-user attribution for agent instances. Interchange's `agent_instance` has
// no owner-user column, so this workbench-side mapping records which member
// principal owns a per-user instance of a given org-level template definition
// (CL-1532). NOT generally unique per (member, template): the original 0016
// unique constraint was dropped in migration 0018 so users can add multiple
// instances of the same shared template from the UI — writers that need
// one-row semantics must bring their own constraint. The only such constraint
// today is the 0061 partial unique index scoping (tenant, member, agent) to
// the invoked-subagent template key, which makes invoke_agent's
// check-then-insert provisioning race-safe.
export const memberAgentInstance = pgTable(
  "member_agent_instance",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    // The user's member principal in the global tenant.
    memberPrincipalId: text("member_principal_id").notNull(),
    templateKey: text("template_key").notNull(),
    // The shared org-level agent definition (seeded by CL-1530) this instances.
    agentId: text("agent_id").notNull(),
    // The per-user agent_instance id.
    instanceId: text("instance_id").notNull(),
    /** UI label for this instance row (Myra threads, etc.). */
    label: text("label"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Most recent activity (a user message to this instance). Bumped by the hub
    // mail middleware so the chat list can order most-recently-active first;
    // seeded to created_at on insert (a fresh thread's only activity is its
    // creation).
    lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
    // When the first user message landed; NULL until the thread is actually
    // used. Thread lists hide never-used threads so "+ New chat" does not
    // mutate the sidebar until first use (CL-3749).
    firstMessageAt: timestamp("first_message_at"),
  },
  () => ({}),
);

/**
 * A member's durable "auto-approve this tool for me" decision (the three-button
 * approval card's "Auto Approve Always"). When recorded, the grant minting
 * (`resolveAskToolNamesForTenant`) excludes the tool for this instance principal,
 * so it mints `effect: "allow"` instead of `ask` and no longer suspends for
 * human approval. Keyed on the agent-instance `principal_id` (what the grant
 * mint keys on), attributed to the member principal who made the trust decision.
 * Revoking a row reverts the tool to `ask` on the next grant reconcile.
 * Workbench-owned only.
 */
export const autoApprovedTool = pgTable(
  "auto_approved_tool",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    // The agent-instance principal the grant mint keys on.
    principalId: text("principal_id").notNull(),
    // LLM-safe tool name (e.g. slack__post_message), matching the ask-set keys.
    toolName: text("tool_name").notNull(),
    // The member principal who made this trust decision (attribution).
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    principalToolUniq: uniqueIndex("auto_approved_tool_principal_tool_uniq").on(
      t.tenantId,
      t.principalId,
      t.toolName,
    ),
  }),
);

/** CL-3686: links a Myra thread (origin conversation) to an invoked subagent mapping. */
export const memberInvokedSubagent = pgTable(
  "member_invoked_subagent",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    memberPrincipalId: text("member_principal_id").notNull(),
    originConversationId: text("origin_conversation_id").notNull(),
    subagentMappingId: text("subagent_mapping_id").notNull(),
    firstInvokedAt: timestamp("first_invoked_at").notNull().defaultNow(),
    lastInvokedAt: timestamp("last_invoked_at").notNull().defaultNow(),
  },
  () => ({}),
);

// ─── Generic versioned templates ───────────────────────────────────
//
// `kind` identifies the template type (e.g. 'gamma'). `config` is a jsonb
// blob whose shape is kind-specific. Only the highest version per template
// is surfaced in the UI. Editing a template creates a new version row,
// preserving history for future A/B testing.

export const workbenchTemplate = pgTable("template", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const workbenchTemplateVersion = pgTable(
  "template_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => workbenchTemplate.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    authorId: text("author_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    templateVersionUniq: unique("template_version_template_id_version_uniq").on(
      t.templateId,
      t.version,
    ),
  }),
);

// ─── Skill access ──────────────────────────────────────────────────
//
// Interchange's `asset` table is @intx-owned and cannot carry workbench access
// metadata, so sharing scope for skill assets lives here (CL-2121). One row per
// skill asset.
//
//   scope = 'tenant'  → visible to everyone whose tenant ancestor chain includes
//                       the asset's tenant (the walk-up share target).
//   scope = 'private' → visible only to the creating user (matched by
//                       owner_user_id, since principal ids are per-tenant and a
//                       user views from different tenants).
//
// A skill asset with no row here predates this feature and is treated as
// 'tenant' (org-wide), preserving the prior implicit behaviour.
export const skillAccessScope = ["private", "tenant"] as const;

export const skillAccess = pgTable("skill_access", {
  assetId: text("asset_id").primaryKey(),
  scope: text("scope", { enum: skillAccessScope }).notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  ownerPrincipalId: text("owner_principal_id").notNull(),
  // One-line summary surfaced in listSkills (e.g. slash-command autocomplete);
  // also baked into the skill's SKILL.md frontmatter at write time.
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SkillAccessRow = typeof skillAccess.$inferSelect;

// workbench_approval (the legacy pre-native ask_principal / ReviewGate rail,
// created in 0011_approval.sql, renamed in 0070 to avoid the interchange
// "approval" table collision) was dropped in migration 0071 (CL-3938): its
// entire code path was deleted in #1134, and the native approval rail
// (interchange's own "approval" table) is now the sole mechanism. Removed
// here so the schema no longer describes a table that no longer exists.

export { feedbackSubjectKinds as feedbackSubjectKind } from "@workbench/shared";
export type { FeedbackSubjectKind } from "@workbench/shared";

export const outputFeedback = pgTable(
  "output_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    instanceId: text("instance_id"),
    subjectKind: text("subject_kind", { enum: feedbackSubjectKinds }).notNull(),
    subjectId: text("subject_id").notNull(),
    rating: integer("rating").notNull().$type<1 | -1>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    outputFeedbackUniq: unique("output_feedback_principal_subject_uniq").on(
      t.principalId,
      t.subjectId,
      t.subjectKind,
    ),
    // Mirror the SQL CHECK from the migration so non-HTTP writers fail at the Drizzle layer.
    ratingCheck: check(
      "output_feedback_rating_check",
      sql`${t.rating} IN (1, -1)`,
    ),
  }),
);

export type OutputFeedbackRow = typeof outputFeedback.$inferSelect;

// Chat uploads are diverted through the parse-file route (file artifact +
// parsed text folded into the message), so the mail record carries no
// attachment. These references key the artifact back to its mail id BY VALUE
// so the transcript chip survives reload (CL-3671). No FK into interchange.
export const mailAttachmentRef = pgTable(
  "mail_attachment_ref",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    instanceId: text("instance_id").notNull(),
    mailId: text("mail_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    mailAttachmentRefMailArtifactUniq: unique(
      "mail_attachment_ref_mail_artifact_uniq",
    ).on(t.mailId, t.artifactId),
    mailAttachmentRefInstanceIdx: index("mail_attachment_ref_instance_idx").on(
      t.instanceId,
    ),
  }),
);

export type MailAttachmentRefRow = typeof mailAttachmentRef.$inferSelect;

// ─── Admin audit (CL-2735) ─────────────────────────────────────────
//
// Compliance record of cross-principal activity reads and admin grant/role
// mutations. Workbench-owned; principal ids referenced by value only.
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    action: text("action", { enum: adminAuditActions }).notNull(),
    actorPrincipalId: text("actor_principal_id").notNull(),
    targetPrincipalId: text("target_principal_id"),
    resource: text("resource"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    adminAuditTenantCreatedIdx: index("admin_audit_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

export type AdminAuditRow = typeof adminAudit.$inferSelect;

// ─── Principal mailbox ─────────────────────────────────────────────
//
// Durable per-principal mailbox for mail addressed to human users (usr_
// addresses). Interchange's session_mail persists inbound rows only for
// agent-instance recipients and skips human addresses; the workbench
// persistMail override (lib/principal-mailbox.ts) writes those frames
// here instead, keyed by the recipient's member principal so the inbox
// read path is a direct equality filter. `raw` is the RFC 2822 frame
// verbatim; `subject`/`from_address` are cached list headers parsed at
// write time. `message_key` is an optional idempotency key for
// programmatically-delivered items (workflow gate mail, `gate:<runId>:<signal>`)
// — the partial unique index below dedupes keyed inserts while leaving the
// keyless human/agent mail unconstrained.
export const principalMailboxDirections = ["inbound", "outbound"] as const;

export const principalMailbox = pgTable(
  "principal_mailbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    principalId: text("principal_id").notNull(),
    address: text("address").notNull(),
    direction: text("direction", {
      enum: principalMailboxDirections,
    }).notNull(),
    raw: bytea("raw").notNull(),
    subject: text("subject"),
    fromAddress: text("from_address"),
    // Dedupe key for hub-written rows (gate:<runId>:<signal>, triage:<row id>);
    // NULL for delivered external mail, unconstrained by the partial index.
    messageKey: text("message_key"),
    // Structured entity references surfaced as the message's "Related" action
    // row. NULL for external mail and any hub-written row whose creator emits
    // none; re-validated through MailboxRefSchema on read, so an old row whose
    // shape no longer validates degrades to no refs rather than a read error.
    refs: jsonb("refs").$type<MailboxRef[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    readAt: timestamp("read_at"),
    archivedAt: timestamp("archived_at"),
    trashedAt: timestamp("trashed_at"),
  },
  (t) => ({
    principalMailboxPrincipalCreatedIdx: index(
      "principal_mailbox_principal_created_idx",
    ).on(t.tenantId, t.principalId, t.createdAt),
    principalMailboxMessageKeyUniq: uniqueIndex(
      "principal_mailbox_message_key_uniq",
    )
      .on(t.tenantId, t.principalId, t.messageKey)
      .where(sql`${t.messageKey} IS NOT NULL`),
  }),
);

export type PrincipalMailboxRow = typeof principalMailbox.$inferSelect;

// Routine triggers: durable per-member schedules that fire a workflow run on
// a recurring cadence (CL-4212). A recurrence is `interval_minutes` (how often)
// plus `anchor_minute_utc` (minute-of-UTC-day phase, 0-1439) that fixes wall-clock
// alignment; the daily-at-hour model is `interval_minutes=1440,
// anchor_minute_utc=hour*60`. The hub scheduler loads enabled rows each tick and
// fires whenever `floor((nowMinuteUtc - anchor_minute_utc) / interval_minutes)`
// advances past `last_fired_window_index`.
// Unique per scope (CL-4108): personal → (tenant, owner, kind); tenant → (tenant, kind).
export const scheduledTrigger = pgTable(
  "scheduled_trigger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    ownerMemberPrincipalId: text("owner_member_principal_id").notNull(),
    workflowKind: text("workflow_kind").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    anchorMinuteUtc: integer("anchor_minute_utc").notNull(),
    // personal = Just for me; tenant = Everyone (CL-4108).
    scope: text("scope").notNull().default("personal"),
    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    enabled: boolean("enabled").notNull().default(true),
    // NOT NULL: every write path (createOwnerSchedule, ensureOwnerSchedule,
    // updateOwnerSchedule, updateTenantScopedSchedule, and migration 0080's
    // backfill for never-fired legacy rows) stamps a real window index — see
    // scheduler.ts shouldFire for why "no last-fired window" must never be
    // representable as an ambiguous NULL.
    lastFiredWindowIndex: integer("last_fired_window_index").notNull(),
    // Most recent run id the scheduler started for this schedule (CL-3526).
    lastRunId: text("last_run_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    scheduledTriggerScopeCheck: check(
      "scheduled_trigger_scope_check",
      sql`${t.scope} IN ('personal', 'tenant')`,
    ),
    scheduledTriggerIntervalCheck: check(
      "scheduled_trigger_interval_check",
      sql`${t.intervalMinutes} >= 1`,
    ),
    scheduledTriggerAnchorCheck: check(
      "scheduled_trigger_anchor_check",
      sql`${t.anchorMinuteUtc} >= 0 AND ${t.anchorMinuteUtc} < 1440`,
    ),
    // Partial uniques (CL-4108): personal is per owner+kind; tenant is per tenant+kind.
    scheduledTriggerPersonalOwnerKindUniq: uniqueIndex(
      "scheduled_trigger_personal_owner_kind_uniq",
    )
      .on(t.tenantId, t.ownerMemberPrincipalId, t.workflowKind)
      .where(sql`${t.scope} = 'personal'`),
    scheduledTriggerTenantKindUniq: uniqueIndex(
      "scheduled_trigger_tenant_kind_uniq",
    )
      .on(t.tenantId, t.workflowKind)
      .where(sql`${t.scope} = 'tenant'`),
  }),
);

export type ScheduledTriggerRow = typeof scheduledTrigger.$inferSelect;

// One row per scheduler fire for a schedule (CL-3526). Join workflow_run_record
// for live status when serving the owner's fire history.
export const scheduledTriggerFire = pgTable(
  "scheduled_trigger_fire",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduledTriggerId: uuid("scheduled_trigger_id")
      .notNull()
      .references(() => scheduledTrigger.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    firedAt: timestamp("fired_at").notNull().defaultNow(),
  },
  (t) => ({
    scheduledTriggerFireScheduleFiredIdx: index(
      "scheduled_trigger_fire_schedule_fired_idx",
    ).on(t.scheduledTriggerId, t.firedAt),
  }),
);

export type ScheduledTriggerFireRow = typeof scheduledTriggerFire.$inferSelect;

// Webhook-triggered workflow runs: a durable per-trigger secret lets
// an external system fire a workflow run over HTTP, without a session.
// `secretHash` is a SHA-256 hash of the trigger secret -- the plaintext is
// returned to the owner exactly once, at creation, and never persisted.
export const workflowTrigger = pgTable("workflow_trigger", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  ownerMemberPrincipalId: text("owner_member_principal_id").notNull(),
  workflowKind: text("workflow_kind").notNull(),
  secretHash: text("secret_hash").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastFiredAt: timestamp("last_fired_at"),
});

export type WorkflowTriggerRow = typeof workflowTrigger.$inferSelect;

// Idempotency ledger for the generic provider-webhook receiver (CL-4269).
// Providers that sign inbound deliveries (Linear today; GitHub/Slack/Attio
// register the same way) retry on timeout/non-200 and resend the SAME
// delivery id for retries of one logical event, so `(provider, delivery_id)`
// is the natural dedup key. `id` is `"<provider>:<deliveryId>"` -- not a
// generated id -- so a redelivery collides on the primary key and the
// insert's own conflict IS the dedupe mechanism, not an application-level
// lookup-then-insert race. `tenant_key` is the provider-native identifier the
// adapter resolved the tenant from (Linear: `organizationId`), kept for audit
// even though the row is already scoped to the resolved `tenant_id`.
export const providerWebhookDelivery = pgTable("provider_webhook_delivery", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  deliveryId: text("delivery_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  tenantKey: text("tenant_key").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});

export type ProviderWebhookDeliveryRow =
  typeof providerWebhookDelivery.$inferSelect;

// Durable poll cursor for inbox intake (CL-3628): one row per scope key
// (`member:<memberPrincipalId>:<sourceKey>` or `workspace:<tenantId>:<sourceKey>`,
// the same keys `inbox-intake.ts` already used for its in-process
// `lastPollAtByScopeKey` map). Read at the top of each source's run, upserted
// only after a successful poll — same advance semantics as the in-memory map,
// now surviving a replica restart/redeploy instead of resetting to a wide
// `lookbackMs` poll. `scopeKey` alone is globally unique (it embeds the tenant
// or member id); `tenantId` is carried alongside for operator debugging/joins.
export const inboxIntakeCursor = pgTable("inbox_intake_cursor", {
  scopeKey: text("scope_key").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  lastPollAt: timestamp("last_poll_at").notNull(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type InboxIntakeCursorRow = typeof inboxIntakeCursor.$inferSelect;

// Durable background work unit (WQ.1–WQ.2). Product tasks are never leased;
// workers claim work_unit rows with FOR UPDATE SKIP LOCKED + lease_until.
//
// The `granola_call` kind (and the `granola-call-job-queue` facade + off-tick
// runner that claimed it) was removed in CL-4213: Granola note processing
// dedupes on artifact `sourceRef` instead (granola-call-artifacts.ts), so it
// needs no lease/claim machinery of its own. This table stays — and so does
// its claiming machinery — because `knowledge_capture`
// (knowledge-capture-outbox.ts / knowledge-capture-hook.ts) and
// `agent_task_turn` (agent-task-auto-pickup.ts) are both still live
// consumers with no natural output key to dedupe on the way Granola's
// artifacts do.
export const workUnitStatuses = ["pending", "leased", "done", "dead"] as const;

export const workUnitKinds = ["knowledge_capture", "agent_task_turn"] as const;

export const workUnit = pgTable(
  "work_unit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: workUnitStatuses })
      .notNull()
      .default("pending"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    workUnitTenantKindKeyUniq: unique("work_unit_tenant_kind_key_uniq").on(
      t.tenantId,
      t.kind,
      t.idempotencyKey,
    ),
    workUnitClaimIdx: index("work_unit_claim_idx").on(
      t.status,
      t.nextAttemptAt,
      t.leaseUntil,
    ),
    workUnitKindStatusIdx: index("work_unit_kind_status_idx").on(
      t.kind,
      t.status,
    ),
    workUnitStatusCheck: check(
      "work_unit_status_check",
      sql`${t.status} IN ('pending', 'leased', 'done', 'dead')`,
    ),
    workUnitAttemptsNonneg: check(
      "work_unit_attempts_nonneg",
      sql`${t.attempts} >= 0`,
    ),
    workUnitMaxAttemptsPos: check(
      "work_unit_max_attempts_pos",
      sql`${t.maxAttempts} > 0`,
    ),
  }),
);

export type WorkUnitRow = typeof workUnit.$inferSelect;

export {
  analyticsEvent,
  analyticsRollupDaily,
  workflowRunFact,
  workflowStepFact,
} from "@workbench/analytics";
