import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";
import type { HubDb } from "../db";
import { getConfig } from "../config";
import { isFeatureEnabledForTenantCached } from "./feature-grants";

const NO_ASK_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * The LLM-safe tool names whose instance grant is minted `effect: "ask"` for a
 * tenant (CL-3934). When the `native-approvals` feature is on for the tenant,
 * this is the approval-gated write set ({@link APPROVAL_GATED_TOOL_NAMES}) —
 * Interchange's authz-extension parks each call awaiting a human decision. When
 * off (the default), it is the empty set, so every tool grant stays `allow` and
 * the legacy behavior is preserved exactly.
 *
 * `native-approvals` is not an owner self-serve feature (it is absent from
 * `FEATURE_GRANT_CATALOG`, so the owner toggle route rejects it), so its
 * production enable path is the staff-controlled env override
 * (`NATIVE_APPROVALS_ENABLED` → `config.nativeApprovalsEnabled`) — a global
 * kill-switch — plus an admin-provisioned member-role grant for a per-tenant
 * staged rollout. An owner can reach neither.
 *
 * The cached feature read is used deliberately: a bulk grant reconcile calls
 * this once per instance, and the memoized variant collapses those into one
 * grant-store query per (tenant, feature) window rather than N identical reads.
 * Feature resolution is fail-closed: a grant-store failure is logged and treated
 * as off, so a lookup error degrades to the legacy allow-everything path rather
 * than blocking every write tool.
 */
export async function resolveAskToolNamesForTenant(
  db: HubDb,
  tenantId: string,
): Promise<ReadonlySet<string>> {
  const enabled = await isFeatureEnabledForTenantCached(
    db,
    tenantId,
    "native-approvals",
    getConfig().nativeApprovalsEnabled,
  );
  return enabled ? APPROVAL_GATED_TOOL_NAMES : NO_ASK_TOOL_NAMES;
}
