import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";
import type { HubDb } from "../db";
import { isFeatureEnabledForTenant } from "./feature-grants";

const NO_ASK_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * The LLM-safe tool names whose instance grant is minted `effect: "ask"` for a
 * tenant (CL-3934). When the tenant's `native-approvals` feature grant is on,
 * this is the approval-gated write set ({@link APPROVAL_GATED_TOOL_NAMES}) —
 * Interchange's authz-extension parks each call awaiting a human decision. When
 * off (the default), it is the empty set, so every tool grant stays `allow` and
 * the legacy behavior is preserved exactly.
 *
 * Feature resolution is fail-closed: a grant-store failure inside
 * `isFeatureEnabledForTenant` is logged there and treated as off, so a lookup
 * error degrades to the legacy allow-everything path rather than blocking every
 * write tool.
 */
export async function resolveAskToolNamesForTenant(
  db: HubDb,
  tenantId: string,
): Promise<ReadonlySet<string>> {
  const enabled = await isFeatureEnabledForTenant(
    db,
    tenantId,
    "native-approvals",
    false,
  );
  return enabled ? APPROVAL_GATED_TOOL_NAMES : NO_ASK_TOOL_NAMES;
}
