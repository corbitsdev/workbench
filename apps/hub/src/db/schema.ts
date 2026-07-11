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
import { adminAuditActions, feedbackSubjectKinds } from "@workbench/shared";

// Postgres bytea has no first-class Drizzle column helper; map it to Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const artifactStatus = ["draft", "approved", "rejected"] as const;
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
export const artifact = pgTable("artifact", {
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
  status: text("status", { enum: artifactStatus }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  // Soft-archive (CL-3156): null = visible, a timestamp = hidden from default
  // listings. Reversible; distinct from `status` so archiving never clobbers a
  // draft/approved/rejected state.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
// (CL-1532). One row per (member principal, template) — the unique key keeps the
// on-join provisioning idempotent and race-safe.
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SkillAccessRow = typeof skillAccess.$inferSelect;

// ─── Approvals ─────────────────────────────────────────────────────

export const approvalStatus = ["pending", "approved", "rejected"] as const;

export const approval = pgTable("approval", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  agentId: text("agent_id").notNull(),
  sessionId: text("session_id"),
  resource: text("resource").notNull(),
  action: text("action").notNull(),
  context: jsonb("context").$type<Record<string, unknown>>(),
  status: text("status", { enum: approvalStatus }).notNull().default("pending"),
  message: text("message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

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
// write time.
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    readAt: timestamp("read_at"),
  },
  (t) => ({
    principalMailboxPrincipalCreatedIdx: index(
      "principal_mailbox_principal_created_idx",
    ).on(t.tenantId, t.principalId, t.createdAt),
  }),
);

export type PrincipalMailboxRow = typeof principalMailbox.$inferSelect;

// Automation triggers: durable per-member schedules that fire a
// workflow run on a daily UTC-hour cadence. The hub scheduler loads enabled
// rows each tick and starts a run for any whose target hour has arrived and has
// not fired today (tracked by `last_fired_day_utc`, the integer UTC day index
// floor(ms / 86_400_000)). `cron` is reserved for a future arbitrary-cadence
// field; only `hour_utc` is honored today. Unique per (tenant, owner, kind) so
// the boot heartbeat seeder is idempotent.
export const scheduledTrigger = pgTable(
  "scheduled_trigger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    ownerMemberPrincipalId: text("owner_member_principal_id").notNull(),
    workflowKind: text("workflow_kind").notNull(),
    hourUtc: integer("hour_utc").notNull(),
    cron: text("cron"),
    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredDayUtc: integer("last_fired_day_utc"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    scheduledTriggerOwnerKindUniq: unique(
      "scheduled_trigger_owner_kind_uniq",
    ).on(t.tenantId, t.ownerMemberPrincipalId, t.workflowKind),
  }),
);

export type ScheduledTriggerRow = typeof scheduledTrigger.$inferSelect;

export {
  analyticsEvent,
  analyticsRollupDaily,
  workflowRunFact,
  workflowStepFact,
} from "@workbench/analytics";
