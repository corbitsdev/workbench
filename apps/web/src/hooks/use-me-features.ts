import { useQuery } from "@tanstack/react-query";
import type { FeatureName, MemberFeaturesResponse } from "@workbench/shared";
import { getMeFeatures } from "../lib/hub-api";

const ME_FEATURES_KEY = ["me", "features"] as const;

/** Member-readable feature enablement for the caller's primary tenant. */
export function useMeFeatures() {
  return useQuery({
    queryKey: ME_FEATURES_KEY,
    queryFn: getMeFeatures,
    staleTime: 5 * 60_000,
  });
}

/** Whether a named feature is enabled. Pending/error → false (hide, don't flash). */
export function isFeatureEnabled(
  data: MemberFeaturesResponse | undefined,
  name: FeatureName,
): boolean {
  return data?.features.some((f) => f.name === name && f.enabled) ?? false;
}
