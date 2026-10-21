import { ApiQueryError } from "@/lib/api-query";
import { TenantDetailSchema, apiRequest, fetchTenantDetail, type TenantDetail } from "../api";

/** Sets one key of the stock tenant config. Read-modify-write on fresh config
 * so other keys are never dropped. */
export async function patchTenantConfigKey(
  tenantId: string,
  key: string,
  value: string,
): Promise<TenantDetail> {
  const current = await fetchTenantDetail(tenantId);
  const path = `/api/tenants/${encodeURIComponent(tenantId)}`;
  return apiRequest(
    path,
    TenantDetailSchema,
    "updating tenant configuration",
    ApiQueryError,
    {
      method: "PATCH",
      body: JSON.stringify({ config: { ...current.config, [key]: value } }),
    },
    fetch,
    { throwUnauthenticatedOn401: true },
  );
}
