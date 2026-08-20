// The shell's guided-fix banner (CL-6092): shown above the stage
// whenever `ProviderHealthProvider` has a classified, undismissed
// provider-health incident. "Fix it" deep-links to Plugins' connect
// panel for that provider (see `../pages/plugins-page.tsx`'s pending-
// connect consumption) — or, when the tenant has zero working providers,
// routes to onboarding's credential step instead, since there is no
// provider gallery worth opening yet.

import { Button } from "@corbits/react-ui";
import { connectorDescriptors } from "@workbench/connections/registry";
import type { ClassifiedInferenceFailureCategory } from "@workbench/connections/provider-health";
import { Warning, X } from "@corbits/icons";
import { useEffect, useState } from "react";

import { useNavigate } from "../navigation";
import { ONBOARDING_PATH } from "../routes";
import {
  useDismissProviderHealthBanner,
  useProviderHealthBanner,
  useRequestPluginsConnect,
  type ProviderHealthBannerState,
} from "./provider-health-context";

const PLUGINS_PATH = "/plugins";

// How long the collapse/fade-out below takes to play before the banner's
// last-known content is finally released — see the CSS pair
// `.provider-health-banner-collapse`/`.provider-health-banner-collapse.is-open`
// in `app.css`. Kept as one constant both sides agree on rather than a
// magic number repeated in two files.
const COLLAPSE_TRANSITION_MS = 220;

// The connector registry's own `displayName` (`@workbench/connections/registry`,
// the same browser-safe subpath `plugins.ts` already reads) — never a
// reinvented title-case of the provider id, which mangles ids like
// `"google-genai"` or `"opencode-zen"` into nonsense. Falls back to the
// bare id for a provider this registry has no descriptor for (never
// expected in practice, but a caller should still see something rather
// than nothing).
function providerDisplayName(provider: string): string {
  const descriptor = connectorDescriptors().find((d) => d.id === provider);
  return descriptor?.displayName ?? provider;
}

// Fixed, pre-written copy per classified category (CL-6092) — the one
// place a `ProviderHealthRecord.category` becomes a sentence. Never a
// provider's own error text: see `provider-health.ts`'s module header for
// why only a closed enum ever reaches this far.
const CATEGORY_COPY: Readonly<
  Record<ClassifiedInferenceFailureCategory, string>
> = {
  credential_failure: "turned down your key.",
  quota_exhausted: "says this key is out of credit.",
};

function bannerMessage(banner: ProviderHealthBannerState): string {
  return `${providerDisplayName(banner.provider)} ${CATEGORY_COPY[banner.category]}`;
}

export function ProviderHealthBanner() {
  const banner = useProviderHealthBanner();
  const dismiss = useDismissProviderHealthBanner();
  const requestPluginsConnect = useRequestPluginsConnect();
  const navigate = useNavigate();

  // Keeps the banner's last-known content mounted for a moment after
  // `banner` goes null, so the collapse/fade-out transition below has
  // something to animate away rather than the stage snapping shut
  // instantly — see the module comment on hard-shoving the stage this
  // replaces. The `role="alert"` below still comes off the LIVE `banner`,
  // not this cache, so a screen reader never sees a stale alert linger.
  const [cachedBanner, setCachedBanner] =
    useState<ProviderHealthBannerState | null>(banner);
  useEffect(() => {
    if (banner !== null) {
      setCachedBanner(banner);
      return;
    }
    const timeout = setTimeout(
      () => setCachedBanner(null),
      COLLAPSE_TRANSITION_MS,
    );
    return () => clearTimeout(timeout);
  }, [banner]);

  const isOpen = banner !== null;

  const handleFix = () => {
    if (banner === null) return;
    if (banner.zeroWorkingProviders) {
      navigate(ONBOARDING_PATH);
      return;
    }
    requestPluginsConnect(banner.provider);
    navigate(PLUGINS_PATH);
  };

  return (
    <div
      className={`provider-health-banner-collapse${isOpen ? " is-open" : ""}`}
    >
      <div className="provider-health-banner-collapse-inner">
        {cachedBanner !== null ? (
          <div
            className="provider-health-banner"
            role={isOpen ? "alert" : undefined}
          >
            <Warning className="provider-health-banner-icon" aria-hidden />
            <p className="provider-health-banner-text">
              {bannerMessage(cachedBanner)}
            </p>
            <Button size="sm" variant="primary" onClick={handleFix}>
              Fix it
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={dismiss}
              aria-label="Dismiss"
            >
              <X aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
