import {
  MYRA_CATALOG_PACKAGES,
  MYRA_TOOL_CATALOG,
  PACKAGE_PROVIDERS_TABLE,
  isMyraCatalogManagedToolName,
  isMyraCatalogPackageKey,
} from "@workbench/agent-core";
import { toLlmToolName } from "@workbench/agents";
import { PERSONAL_AGENT_BASE_TOOLS } from "@workbench/myra";
import {
  filterCatalogByAvailableTools,
  type ToolCatalogEntry,
} from "@workbench/tools-catalog";
import { createGrantStore } from "@intx/db";
import type { HubDb } from "../db";
import { isCapabilityAllowedForPrincipal } from "./capability-grants";
import { resolveMemberOrTenantToolCredential } from "./member-tool-credential";

const WORKSPACE_GRANTED_LLM_NAMES = new Set(
  PERSONAL_AGENT_BASE_TOOLS.map((name) => toLlmToolName(name)),
);

function providerPinForCatalogPackage(packageKey: string): string | undefined {
  return MYRA_CATALOG_PACKAGES.find((p) => p.package === packageKey)?.pin;
}

/**
 * Catalog packages the member may narrow (workspace grants ∩ credential/oauth).
 * Owner-disabled packages are omitted (CL-3584 cascade).
 */
export async function listMemberMyraToolCatalog(
  db: HubDb,
  tenantId: string,
  memberPrincipalId: string,
): Promise<ToolCatalogEntry[]> {
  const grantFiltered = filterCatalogByAvailableTools(
    MYRA_TOOL_CATALOG,
    WORKSPACE_GRANTED_LLM_NAMES,
  );
  const grantStore = createGrantStore(db);
  const visible: ToolCatalogEntry[] = [];
  for (const entry of grantFiltered) {
    const pin = providerPinForCatalogPackage(entry.package);
    const provider = pin ? PACKAGE_PROVIDERS_TABLE[pin] : undefined;
    if (provider) {
      const allowed = await isCapabilityAllowedForPrincipal(
        grantStore,
        tenantId,
        memberPrincipalId,
        provider,
      );
      if (!allowed) continue;
      const credential = await resolveMemberOrTenantToolCredential(
        db,
        tenantId,
        memberPrincipalId,
        provider,
      );
      if (!credential) continue;
    }
    visible.push(entry);
  }
  return visible;
}

export function sanitizeMemberMyraToolDisables(
  catalog: readonly ToolCatalogEntry[],
  disabledCatalogPackages: string[],
  disabledToolNames: string[],
): { disabledCatalogPackages: string[]; disabledToolNames: string[] } {
  const packageKeys = new Set(catalog.map((e) => e.package));
  const toolNames = new Set(catalog.flatMap((e) => e.tools.map((t) => t.name)));
  const packages = [
    ...new Set(
      disabledCatalogPackages.filter(
        (p) => packageKeys.has(p) && isMyraCatalogPackageKey(p),
      ),
    ),
  ];
  const tools = [
    ...new Set(
      disabledToolNames.filter(
        (t) =>
          toolNames.has(t) &&
          isMyraCatalogManagedToolName(t) &&
          !packages.some((pkg) =>
            catalog
              .find((e) => e.package === pkg)
              ?.tools.some((tool) => tool.name === t),
          ),
      ),
    ),
  ];
  return { disabledCatalogPackages: packages, disabledToolNames: tools };
}
