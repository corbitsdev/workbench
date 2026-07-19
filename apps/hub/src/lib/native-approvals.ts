import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";
import type { HubDb } from "../db";
import { resolveAutoApprovedToolNames } from "./auto-approved-tools";

/**
 * The LLM-safe tool names whose instance grant is minted `effect: "ask"` — the
 * approval-gated write set ({@link APPROVAL_GATED_TOOL_NAMES}) minus the tools
 * this instance principal has durably auto-approved (CL-3942). Interchange's
 * authz-extension parks each `ask` call awaiting a human decision, so every
 * write-classified tool (`sideEffect: "write"`) requires approval before it
 * runs — unless the member chose "Auto Approve Always" for that tool, which
 * records an `auto_approved_tool` row and excludes it here so its grant mints
 * `allow` and it runs unattended. This is otherwise unconditional (CL-3940):
 * there is no owner toggle and no env kill-switch. Read-classified tools are
 * absent from the gated set, so their grants stay `allow`.
 */
export async function resolveAskToolNamesForTenant(
  db: HubDb,
  tenantId: string,
  principalId: string,
): Promise<ReadonlySet<string>> {
  const autoApproved = await resolveAutoApprovedToolNames(
    db,
    tenantId,
    principalId,
  );
  if (autoApproved.size === 0) return APPROVAL_GATED_TOOL_NAMES;
  const ask = new Set<string>();
  for (const name of APPROVAL_GATED_TOOL_NAMES) {
    if (!autoApproved.has(name)) ask.add(name);
  }
  return ask;
}
