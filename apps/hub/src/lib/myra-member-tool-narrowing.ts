import { narrowMyraToolNamesByMemberPreference } from "@workbench/agent-core";
import { and, eq } from "drizzle-orm";
import type { HubDb } from "../db";
import { memberAgentInstance, myraVariantPreference } from "../db/schema";
import {
  listMemberMyraToolCatalog,
  sanitizeMemberMyraToolDisables,
} from "./myra-member-tool-settings";

/**
 * Apply per-member Myra tool narrowing at launch (chat + triage). Never widens
 * the workspace grant set.
 */
export async function narrowToolNamesForMemberMyraLaunch(
  db: HubDb,
  tenantId: string,
  instanceId: string,
  grantedToolNames: readonly string[],
): Promise<string[]> {
  const mapping = await db.query.memberAgentInstance.findFirst({
    where: and(
      eq(memberAgentInstance.tenantId, tenantId),
      eq(memberAgentInstance.instanceId, instanceId),
    ),
  });
  if (!mapping) return [...grantedToolNames];

  const memberPrincipalId = mapping.memberPrincipalId;
  const [row] = await db
    .select({
      disabledCatalogPackages: myraVariantPreference.disabledCatalogPackages,
      disabledToolNames: myraVariantPreference.disabledToolNames,
    })
    .from(myraVariantPreference)
    .where(
      and(
        eq(myraVariantPreference.tenantId, tenantId),
        eq(myraVariantPreference.memberPrincipalId, memberPrincipalId),
      ),
    )
    .limit(1);

  const disabledPackages = row?.disabledCatalogPackages ?? [];
  const disabledTools = row?.disabledToolNames ?? [];
  if (disabledPackages.length === 0 && disabledTools.length === 0) {
    return [...grantedToolNames];
  }

  const catalog = await listMemberMyraToolCatalog(
    db,
    tenantId,
    memberPrincipalId,
  );
  const sanitized = sanitizeMemberMyraToolDisables(
    catalog,
    disabledPackages,
    disabledTools,
  );

  return narrowMyraToolNamesByMemberPreference(
    grantedToolNames,
    sanitized.disabledCatalogPackages,
    sanitized.disabledToolNames,
  );
}
