import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";

import { ApiQueryError } from "@/lib/api-query";
import { TenantDetailSchema, fetchTenantDetail, type TenantDetail } from "../api";

export const DESCRIPTION_MAX = 280;

const DescriptionConfig = type({ "workbench.description?": `string <= ${DESCRIPTION_MAX}` });

/** The description lives in the stock tenant config; anything malformed reads
 * as no description. */
export function readDescription(config: TenantDetail["config"]): string {
  const parsed = DescriptionConfig(config ?? {});
  return parsed instanceof type.errors ? "" : (parsed["workbench.description"] ?? "");
}

const descriptionKey = (tenantId: string) => ["workbench", tenantId, "description"] as const;

export function useBenchDescription(tenantId: string) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: descriptionKey(tenantId),
    queryFn: () => fetchTenantDetail(tenantId),
  });
  const save = useMutation({
    mutationFn: async (text: string) => {
      // Read-modify-write on fresh config so other keys are never dropped.
      const current = await fetchTenantDetail(tenantId);
      const path = `/api/tenants/${encodeURIComponent(tenantId)}`;
      const response = await fetch(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { ...current.config, "workbench.description": text } }),
      });
      if (!response.ok) {
        throw new ApiQueryError(`The server answered ${response.status}.`, response.status, path);
      }
      const parsed = TenantDetailSchema(await response.json());
      if (parsed instanceof type.errors) {
        throw new ApiQueryError(`Unexpected tenant response shape: ${parsed.summary}`);
      }
      return parsed;
    },
    onSuccess: (tenant) => queryClient.setQueryData(descriptionKey(tenantId), tenant),
  });
  return {
    description: query.data === undefined ? "" : readDescription(query.data.config),
    save,
  };
}
