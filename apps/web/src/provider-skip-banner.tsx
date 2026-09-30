import { NoUsableModelBanner } from "@/chat";

import { useNavigate } from "./navigation";
import { useProviderSkipped } from "./provider-skip";

export const PROVIDER_SETTINGS_PATH = "/settings/credentials";

/** Shown wherever a model is required, until a provider is connected. */
export function ProviderSkipBanner() {
  const navigate = useNavigate();
  const skipped = useProviderSkipped();
  if (!skipped) return null;
  return <NoUsableModelBanner onConnectModel={() => navigate(PROVIDER_SETTINGS_PATH)} />;
}
