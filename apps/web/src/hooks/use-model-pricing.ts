import { useQuery } from "@tanstack/react-query";
import { getModelPricing } from "../lib/hub-api";

/**
 * Hub-cached models.dev rate catalog (CL-2714). Rates change rarely, so a long
 * `staleTime` is correct — this is catalog data, not live usage.
 */
export function useModelPricing(tenantId: string) {
  return useQuery({
    queryKey: ["model-pricing", tenantId],
    queryFn: () => getModelPricing(tenantId),
    enabled: tenantId !== "",
    staleTime: 30 * 60_000,
    gcTime: 60 * 60_000,
    retry: (failureCount, error) => {
      const status = (error as { status?: number }).status;
      if (status === 503 && failureCount < 3) {
        return true;
      }
      return failureCount < 1;
    },
  });
}
