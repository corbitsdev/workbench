import { NoUsableModelBanner } from "@/chat";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useBench } from "./bench-context";
import { useNavigate, useSessionUser } from "./navigation";
import { clearProviderSkipWhenUsable, useProviderSkipped } from "./provider-skip";
import { getResolvedCatalog } from "./settings/inference";

export const PROVIDER_SETTINGS_PATH = "/settings/credentials";

/** Shown wherever a model is required, until a usable model exists. */
export function ProviderSkipBanner() {
  const navigate = useNavigate();
  const user = useSessionUser();
  const { selectedTenantId } = useBench();
  const skipped = useProviderSkipped();
  const catalog = useQuery({
    queryKey: ["tenant", selectedTenantId ?? "none", "resolved-catalog"] as const,
    queryFn: () => getResolvedCatalog(selectedTenantId ?? ""),
    enabled: skipped && selectedTenantId !== null,
  });
  useEffect(() => {
    if (user !== undefined && catalog.data !== undefined) {
      clearProviderSkipWhenUsable(user.id, catalog.data);
    }
  }, [user, catalog.data]);
  if (!skipped) return null;
  return <NoUsableModelBanner onConnectModel={() => navigate(PROVIDER_SETTINGS_PATH)} />;
}
