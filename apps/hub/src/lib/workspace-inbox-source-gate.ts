import { evaluateGrants } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  WORKSPACE_INBOX_SOURCE_ACTION,
  workspaceInboxSourceResource,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { loadMemberRoleGrantsForTenantChain } from "./workflow-run-gate";

const log = getLogger(["lib", "workspace-inbox-source-gate"]);

/**
 * Whether a workspace-scope inbox source is enabled for a tenant. Deny-by-
 * default (mirrors feature grants): absent any grant the source stays OFF; an
 * `allow` on the tenant's system `member` role for
 * `inbox-source:<key>`/`enable` (owner-written) turns it on. A grant-store
 * failure is logged and treated as DISABLED — never fails open.
 */
export async function isWorkspaceInboxSourceEnabledForTenant(
  db: HubDb,
  tenantId: string,
  sourceKey: string,
): Promise<boolean> {
  try {
    const grants = await loadMemberRoleGrantsForTenantChain(db, [tenantId]);
    const result = await evaluateGrants(
      grants,
      workspaceInboxSourceResource(sourceKey),
      WORKSPACE_INBOX_SOURCE_ACTION,
    );
    return result.effect === "allow";
  } catch (err) {
    log.error(
      "workspace-inbox-source-gate: grant check failed; treating source as disabled",
      {
        tenantId,
        sourceKey,
        error: err instanceof Error ? err : new Error(String(err)),
      },
    );
    return false;
  }
}
