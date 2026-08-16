// The shell's guided-fix banner (CL-6092): shown above the stage
// whenever `ProviderHealthProvider` has a classified, undismissed
// provider-health incident. "Fix it" deep-links to Plugins' connect
// panel for that provider (see `../pages/plugins-page.tsx`'s pending-
// connect consumption) — or, when the tenant has zero working providers,
// routes to onboarding's credential step instead, since there is no
// provider gallery worth opening yet.

import { Button } from "@corbits/react-ui";
import { TriangleAlert, X } from "lucide-react";

import { useNavigate } from "../navigation";
import { ONBOARDING_PATH } from "../routes";
import {
  useDismissProviderHealthBanner,
  useProviderHealthBanner,
  useRequestPluginsConnect,
} from "./provider-health-context";

const PLUGINS_PATH = "/plugins";

function providerDisplayName(provider: string): string {
  return provider
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function ProviderHealthBanner() {
  const banner = useProviderHealthBanner();
  const dismiss = useDismissProviderHealthBanner();
  const requestPluginsConnect = useRequestPluginsConnect();
  const navigate = useNavigate();

  if (banner === null) return null;

  const handleFix = () => {
    if (banner.zeroWorkingProviders) {
      navigate(ONBOARDING_PATH);
      return;
    }
    requestPluginsConnect(banner.provider);
    navigate(PLUGINS_PATH);
  };

  return (
    <div className="provider-health-banner" role="alert">
      <TriangleAlert className="provider-health-banner-icon" aria-hidden />
      <p className="provider-health-banner-text">
        Your {providerDisplayName(banner.provider)} connection needs
        attention — {banner.reason}.
      </p>
      <Button size="sm" variant="secondary" onClick={handleFix}>
        Fix it
      </Button>
      <button
        type="button"
        className="provider-health-banner-dismiss"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <X aria-hidden />
      </button>
    </div>
  );
}
