import type { DB } from "@intx/db";
import { listVisibleOfferings } from "@intx/db";
import type { PriceCatalog } from "@workbench/pricing";

export type OfferingProvidersByModel = NonNullable<
  PriceCatalog["offeringProvidersByModel"]
>;

export async function getOfferingProvidersByModel(
  db: DB["db"],
  tenantId: string,
): Promise<OfferingProvidersByModel> {
  const offerings = await listVisibleOfferings(db, tenantId);
  const byModel: OfferingProvidersByModel = {};
  for (const resolved of offerings) {
    const model = resolved.model.canonicalName;
    const provider = resolved.provider.name;
    const existing = byModel[model];
    if (existing === undefined) {
      byModel[model] = [provider];
      continue;
    }
    if (!existing.includes(provider)) {
      existing.push(provider);
    }
  }
  return byModel;
}
