import type { TimelineSourceDescriptor } from "./descriptor";

// One descriptor per activity source. Timestamp-semantics audit lives on each
// descriptor: `meaning` says what the column records (event-occurred vs
// row-created vs last-updated) and `clientSupplied` flags any timestamp not
// written by the hub's own clock.
export const timelineSources: readonly TimelineSourceDescriptor[] = [
  {
    kind: "session",
    table: "agent_session",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    summarySql: "src.status",
  },
  {
    kind: "message",
    table: "session_mail",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
    },
    tenantScope: { column: "tenant_id" },
    principalScope: {
      exists: {
        table: "agent_session",
        localColumn: "session_id",
        foreignColumn: "id",
        scopeColumn: "principal_id",
      },
    },
    summarySql: "src.direction",
  },
  {
    kind: "inference_turn",
    table: "inference_turn",
    idColumn: "id",
    timestamp: {
      column: "started_at",
      meaning: "event-occurred",
      clientSupplied: false,
      note: "Written by the hub event collector when the turn starts.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: {
      exists: {
        table: "agent_session",
        localColumn: "session_id",
        foreignColumn: "id",
        scopeColumn: "principal_id",
      },
    },
    summarySql: "src.model",
  },
  {
    kind: "tool_call",
    table: "analytics_event",
    idColumn: "id",
    timestamp: {
      column: "occurred_at",
      meaning: "event-occurred",
      clientSupplied: true,
      note: "occurred_at is carried on the sidecar-emitted event, not stamped by the hub; created_at is the hub receipt time.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    filterSql: "src.event_type = 'tool_call'",
    summarySql: "coalesce(src.metadata ->> 'toolName', src.tool_call_id)",
  },
  {
    kind: "compaction",
    table: "analytics_event",
    idColumn: "id",
    timestamp: {
      column: "occurred_at",
      meaning: "event-occurred",
      clientSupplied: true,
      note: "occurred_at is carried on the sidecar-emitted event, not stamped by the hub; created_at is the hub receipt time.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    filterSql: "src.event_type = 'compaction'",
    // Raw before→after turn counts from the compaction event metadata
    // (CL-3839). '?' stands in when a count was not recorded.
    summarySql:
      "coalesce(src.metadata ->> 'turnsIn', '?') || '→' || coalesce(src.metadata ->> 'turnsOut', '?')",
  },
  {
    kind: "workflow_run",
    table: "workflow_run_record",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
      note: "started_at is nullable (projection-written); created_at is always present and hub-stamped.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    filterSql: "src.deleted_at is null",
    summarySql: "src.kind || ' ' || src.status",
  },
  {
    kind: "artifact",
    table: "artifact",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { anyColumn: ["principal_id", "owner_principal_id"] },
    summarySql: "src.title",
  },
  {
    kind: "artifact_version",
    table: "artifact_version",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
    },
    tenantScope: {
      exists: {
        table: "artifact",
        localColumn: "artifact_id",
        foreignColumn: "id",
        scopeColumn: "tenant_id",
      },
    },
    principalScope: { column: "author_id" },
    summarySql: "src.title",
  },
  {
    kind: "upload",
    table: "upload",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    summarySql: "src.filename",
  },
  {
    kind: "memory",
    table: "memory",
    idColumn: "id",
    timestamp: {
      column: "updated_at",
      meaning: "last-updated",
      clientSupplied: false,
      note: "Memory is a plain overwrite; only the latest write is observable.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "owner_principal_id" },
    summarySql: "left(src.content, 140)",
    // Redact memory content on the tenant-wide feed — the row still surfaces as
    // a "Memory" activity event, without broadcasting the snippet to every
    // member (CL-2743 F2).
    tenantWideSummarySql: "null::text",
  },
  {
    kind: "approval",
    table: "approval",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    summarySql: "src.resource || ' ' || src.action || ' ' || src.status",
  },
  {
    kind: "output_feedback",
    table: "output_feedback",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
      note: "A re-rating updates updated_at only; the entry reflects the first rating.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    summarySql: "src.subject_kind || ' ' || cast(src.rating as text)",
  },
  {
    kind: "grant",
    table: "grant",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
      note: "Current-state table: entries reflect grants that still exist; role-scoped rows (null principal_id) are excluded.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    // `<resource> <action> <origin> <effect>` — origin (system/role/creator/
    // invoker) rides second-to-last so the trailing token stays the effect: the
    // grant parsers (grantEffect / describeGrant) read the FIRST token as the
    // resource and the LAST as the effect, and grantOrigin reads the token
    // before the effect. Never append origin last or the effect parse breaks.
    summarySql:
      "src.resource || ' ' || src.action || ' ' || src.origin || ' ' || src.effect",
  },
  {
    kind: "credential",
    table: "credential",
    idColumn: "id",
    timestamp: {
      column: "created_at",
      meaning: "row-created",
      clientSupplied: false,
      note: "Tenant-owned credentials (null principal_id) are excluded from the per-principal view.",
    },
    tenantScope: { column: "tenant_id" },
    principalScope: { column: "principal_id" },
    summarySql: "src.name",
    // Redact the credential name on the tenant-wide feed — every member sees a
    // "Credential" activity event without the name itself (CL-2743 F2).
    tenantWideSummarySql: "null::text",
  },
];
