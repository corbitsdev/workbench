import { type } from "arktype";

import type { TimelineEntryKind } from "./entry-schema";

export const TimestampSemanticsSchema = type({
  column: "string > 0",
  meaning: "'event-occurred' | 'row-created' | 'last-updated'",
  clientSupplied: "boolean",
  "note?": "string",
});
export type TimestampSemantics = typeof TimestampSemanticsSchema.infer;

// Scoping is declarative, not free-form SQL, so every descriptor carries a
// tenant and principal predicate by construction — the generator refuses to
// build a branch without both.
export const ColumnScopeSchema = type({ column: "string > 0" });
export type ColumnScope = typeof ColumnScopeSchema.infer;

export const AnyColumnScopeSchema = type({ anyColumn: "(string > 0)[] > 0" });
export type AnyColumnScope = typeof AnyColumnScopeSchema.infer;

export const ExistsScopeSchema = type({
  exists: {
    table: "string > 0",
    localColumn: "string > 0",
    foreignColumn: "string > 0",
    scopeColumn: "string > 0",
  },
});
export type ExistsScope = typeof ExistsScopeSchema.infer;

export const TenantScopeSchema = ColumnScopeSchema.or(ExistsScopeSchema);
export type TenantScope = typeof TenantScopeSchema.infer;

export const PrincipalScopeSchema = type.or(
  ColumnScopeSchema,
  AnyColumnScopeSchema,
  ExistsScopeSchema,
);
export type PrincipalScope = typeof PrincipalScopeSchema.infer;

export type TimelineSourceDescriptor = {
  kind: TimelineEntryKind;
  table: string;
  idColumn: string;
  timestamp: TimestampSemantics;
  tenantScope: TenantScope;
  principalScope: PrincipalScope;
  // Static SQL fragment over the `src` alias (e.g. soft-delete or type filters).
  filterSql?: string;
  // Static SQL text expression over the `src` alias projected as `summary`.
  summarySql: string;
  // Privacy (CL-2743, critique F2): a source whose per-principal `summarySql`
  // exposes sensitive free text (memory content, credential names) sets this to
  // the redacted expression used ONLY on the TENANT-WIDE feed — where every
  // member sees every member's activity. The deliberate per-principal
  // drill-down keeps the full `summarySql`. When unset the summary is identical
  // on both scopes.
  tenantWideSummarySql?: string;
};

// `principalIds` is a set because human activity spans principals: the user's
// member principal plus the synthetic principals of agent instances they own
// (sessions, mail, turns, and tool calls attribute to the instance principal,
// not the user). Callers resolve the set; the generator scopes every branch
// to it by construction.
//
// The sentinel `"all"` is the deliberate tenant-wide scope: it drops the
// principal predicate so a branch is scoped by tenant alone (every principal's
// activity in the tenant). It is a distinct sentinel — never an empty array —
// so an accidentally-empty attribution set can never silently widen into an
// unscoped tenant read (`assertValidScope` still rejects `[]`).
export const TENANT_WIDE_SCOPE = "all";
export type TimelineScope = {
  tenantId: string;
  principalIds: readonly string[] | typeof TENANT_WIDE_SCOPE;
};
