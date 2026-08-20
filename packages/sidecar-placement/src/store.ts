// Reads and writes Interchange's native TenantConfig.sidecarPlacement
// field directly on the tenant row's `config` jsonb column — there is no
// package-owned side-table here, unlike @corbits/bench's purpose/type,
// because sidecarPlacement is a field the platform's own sidecar-
// allocation subsystem (@intx/hub-sessions) already reads off TenantConfig.
import { eq } from "drizzle-orm";

import type { DB } from "@intx/db";
import { tenant } from "@intx/db/schema";
import { TenantConfig, type SidecarPlacementRequirement } from "@intx/types";

/**
 * The one placement this setting ever writes: an exclusive sidecar that
 * still reuses the same deployment across a workbench's own workflow
 * occurrences, rather than provisioning fresh infrastructure per run.
 *
 * This cannot name which backend serves that exclusive sidecar.
 * `SidecarPlacementRequirement` (vendor/intx/types/src/sidecar-placement.ts)
 * carries only `sharing`/`reuse`, and `@intx/hub-sessions`'s
 * `WorkflowAllocationService.prepareExclusiveDeployment` always resolves
 * the backend via `plugins.getDefaultProvisioner()` — there is no per-
 * placement provisioner id anywhere in the platform's exclusive-placement
 * path (CL-6283 investigation). Which backend an exclusive placement
 * actually lands on is therefore a hub-wide setting
 * (`SIDECAR_DEFAULT_PROVISIONER` in `apps/hub/src/config.ts`), not a
 * per-tenant one; a parallel side-channel here would not be honored by
 * the platform, so this store intentionally stays boolean-only until the
 * platform's own type grows a provisioner id.
 */
export const WORKBENCH_OWN_SIDECAR_PLACEMENT: SidecarPlacementRequirement =
  Object.freeze({
    sharing: "exclusive",
    reuse: "same-deployment",
  });

export type SidecarPlacementStore = {
  /** False for a tenant with no config row, or no sidecarPlacement key. */
  getEnabled(tenantId: string): Promise<boolean>;
  /**
   * Sets or clears sidecarPlacement, preserving every other key already
   * present in the tenant's config. Returns the resulting enabled state.
   * Throws if the tenant does not exist.
   */
  setEnabled(tenantId: string, enabled: boolean): Promise<boolean>;
};

function parseConfig(value: unknown): TenantConfig {
  if (value === null || value === undefined) return TenantConfig.assert({});
  return TenantConfig.assert(value);
}

export function createDrizzleSidecarPlacementStore(
  db: DB["db"],
): SidecarPlacementStore {
  return {
    async getEnabled(tenantId) {
      const row = await db.query.tenant.findFirst({
        where: eq(tenant.id, tenantId),
        columns: { config: true },
      });
      if (row === undefined) return false;
      return parseConfig(row.config).sidecarPlacement?.sharing === "exclusive";
    },

    async setEnabled(tenantId, enabled) {
      return db.transaction(async (tx) => {
        // Locks the tenant row for the lifetime of this transaction, the
        // same pattern @corbits/chat's channel-tenancy.ts uses for its
        // own read-modify-write: a second concurrent setEnabled() for
        // this tenant blocks here rather than racing this one's read of
        // `config` and clobbering whichever write lands second.
        const [row] = await tx
          .select({ config: tenant.config })
          .from(tenant)
          .where(eq(tenant.id, tenantId))
          .for("update")
          .limit(1);
        if (row === undefined) {
          throw new Error(`setEnabled: tenant ${tenantId} does not exist`);
        }
        // The tenant's config carries keys owned by other domains
        // alongside sidecarPlacement; preserving them requires reading
        // the whole blob back rather than writing an explicit literal.
        const nextConfig: TenantConfig = { ...parseConfig(row.config) };
        if (enabled) {
          nextConfig.sidecarPlacement = WORKBENCH_OWN_SIDECAR_PLACEMENT;
        } else {
          delete nextConfig.sidecarPlacement;
        }
        await tx
          .update(tenant)
          .set({ config: nextConfig, updatedAt: new Date() })
          .where(eq(tenant.id, tenantId));
        return enabled;
      });
    },
  };
}

/** In-memory store for route-level unit tests. */
export function createMemorySidecarPlacementStore(): SidecarPlacementStore {
  const rows = new Map<string, TenantConfig>();

  return {
    async getEnabled(tenantId) {
      return rows.get(tenantId)?.sidecarPlacement?.sharing === "exclusive";
    },
    async setEnabled(tenantId, enabled) {
      const current = rows.get(tenantId) ?? TenantConfig.assert({});
      const nextConfig: TenantConfig = { ...current };
      if (enabled) {
        nextConfig.sidecarPlacement = WORKBENCH_OWN_SIDECAR_PLACEMENT;
      } else {
        delete nextConfig.sidecarPlacement;
      }
      rows.set(tenantId, nextConfig);
      return enabled;
    },
  };
}
