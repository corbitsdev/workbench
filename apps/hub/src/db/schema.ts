import {
  type AnyPgColumn,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Postgres bytea has no first-class Drizzle column helper; map it to Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const severity = ["low", "medium", "high", "critical"] as const;
export const artifactStatus = ["draft", "approved", "rejected"] as const;
export const transcriptSource = ["paste", "granola", "artifact"] as const;

export const transcript = pgTable("transcript", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  source: text("source", { enum: transcriptSource }).notNull().default("paste"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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

export const workflowRun = pgTable("workflow_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  principalId: text("principal_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const painPoint = pgTable("pain_point", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => workflowRun.id, { onDelete: "cascade" }),
  severity: text("severity", { enum: severity }).notNull(),
  context: text("context").notNull(),
  quote: text("quote").notNull(),
  selected: boolean("selected").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// A first-class output of any workflow or agent. `kind` is free-form text
// (validated at the application edge, not a pg enum, so kinds can grow without
// migrations). Nesting via parent_id; provenance via pain_point_id (nullable).
export const artifact = pgTable("artifact", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id"),
  principalId: text("principal_id"),
  sessionId: uuid("session_id").references(() => workflowRun.id, {
    onDelete: "cascade",
  }),
  parentId: uuid("parent_id").references((): AnyPgColumn => artifact.id, {
    onDelete: "cascade",
  }),
  painPointId: uuid("pain_point_id").references(() => painPoint.id, {
    onDelete: "set null",
  }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  source: jsonb("source").$type<Record<string, unknown>>(),
  status: text("status", { enum: artifactStatus }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
    createdAt: timestamp("created_at").notNull().defaultNow(),
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
