import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";

import { fetchTenantDetail, type TenantDetail } from "../api";
import { patchTenantConfigKey } from "./tenant-config";

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
    mutationFn: (text: string) => patchTenantConfigKey(tenantId, "workbench.description", text),
    onSuccess: (tenant) => queryClient.setQueryData(descriptionKey(tenantId), tenant),
  });
  return {
    description: query.data === undefined ? "" : readDescription(query.data.config),
    save,
  };
}
