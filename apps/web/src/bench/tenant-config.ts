import { type } from "arktype";

import { ApiQueryError } from "@/lib/api-query";
import { TenantDetailSchema, fetchTenantDetail, type TenantDetail } from "../api";

/** Sets one key of the stock tenant config. Read-modify-write on fresh config
 * so other keys are never dropped. */
export async function patchTenantConfigKey(
  tenantId: string,
  key: string,
  value: string,
): Promise<TenantDetail> {
  const current = await fetchTenantDetail(tenantId);
  const path = `/api/tenants/${encodeURIComponent(tenantId)}`;
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { ...current.config, [key]: value } }),
  });
  if (!response.ok) {
    throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
  }
  const parsed = TenantDetailSchema(await response.json());
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(`Unexpected tenant response shape: ${parsed.summary}`);
  }
  return parsed;
}
