// The shell's guided-fix banner (CL-6092): shown above the stage
// whenever `ProviderHealthProvider` has a classified, undismissed
// provider-health incident *and* the person is on Settings or the
// broken room (CL-6734). It is not a sticky toast on Skills, Files,
// Mission Control, or Plugins — recovery lives on the surface that
// broke. "Fix it" deep-links to Plugins' connect panel for that
// provider (see `../pages/plugins-page.tsx`'s pending-connect
// consumption) — or, when the tenant has zero working providers,
// routes to onboarding's credential step instead, since there is no
// provider gallery worth opening yet.
//
// Chrome kinds (CL-6834): `unknown` (still polling), `error` (first-load
// poll failed — not the same silence as healthy), `healthy` (ready and
// nothing unhealthy), and `unhealthy` (guided Fix-it banner).

import { Button } from "@corbits/react-ui";
import { connectorDescriptors } from "@corbits/connections/registry";
import type { ClassifiedInferenceFailureCategory } from "@corbits/connections/provider-health";
import { Warning, X } from "@corbits/icons";
import { useEffect, useState } from "react";

import { useNavigate } from "../navigation";
import { matchesRoute, ONBOARDING_PATH, SETTINGS_PATH } from "../routes";
import { WORKBENCH_PATH_PREFIX } from "../workbench-path";
import {
  useDismissProviderHealthBanner,
  useProviderHealthChrome,
  useRequestPluginsConnect,
  type ProviderHealthBannerState,
  type ProviderHealthChrome,
} from "./provider-health-context";

const PLUGINS_PATH = "/plugins";

// CL-6734: recovery on Settings and the room only — never a stalker toast.
export function isProviderHealthRecoverySurface(path: string): boolean {
  return (
    matchesRoute(SETTINGS_PATH, path) ||
    matchesRoute(WORKBENCH_PATH_PREFIX, path)
  );
}

// How long the collapse/fade-out below takes to play before the banner's
// last-known content is finally released — see the CSS pair
// `.provider-health-banner-collapse`/`.provider-health-banner-collapse.is-open`
// in `app.css`. Kept as one constant both sides agree on rather than a
// magic number repeated in two files.
const COLLAPSE_TRANSITION_MS = 220;

const POLL_ERROR_COPY = "Couldn't check provider health. Try again shortly.";

// The connector registry's own `displayName` (`@corbits/connections/registry`,
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

type VisibleChrome =
  | { readonly kind: "error" }
  | { readonly kind: "unhealthy"; readonly banner: ProviderHealthBannerState };

function visibleFromChrome(chrome: ProviderHealthChrome): VisibleChrome | null {
  if (chrome.kind === "error") return { kind: "error" };
  if (chrome.kind === "unhealthy") return chrome;
  return null;
}

export function ProviderHealthBanner({ path }: { readonly path: string }) {
  const chrome = useProviderHealthChrome();
  const dismiss = useDismissProviderHealthBanner();
  const requestPluginsConnect = useRequestPluginsConnect();
  const navigate = useNavigate();

  const visible = visibleFromChrome(chrome);
  // Stable deps for the cache effect — `visible` is a fresh object each
  // render, so depending on it would loop (setState → re-render → new
  // object → effect again).
  const visibleKind = visible?.kind ?? null;
  const unhealthyBanner = chrome.kind === "unhealthy" ? chrome.banner : null;

  // Keeps the banner's last-known content mounted for a moment after
  // `visible` goes null, so the collapse/fade-out transition below has
  // something to animate away rather than the stage snapping shut
  // instantly — see the module comment on hard-shoving the stage this
  // replaces. The `role="alert"` below still comes off the LIVE chrome,
  // not this cache, so a screen reader never sees a stale alert linger.
  const [cachedVisible, setCachedVisible] = useState<VisibleChrome | null>(
    visible,
  );
  useEffect(() => {
    if (visibleKind === "error") {
      setCachedVisible({ kind: "error" });
      return;
    }
    if (visibleKind === "unhealthy" && unhealthyBanner !== null) {
      setCachedVisible({ kind: "unhealthy", banner: unhealthyBanner });
      return;
    }
    const timeout = setTimeout(
      () => setCachedVisible(null),
      COLLAPSE_TRANSITION_MS,
    );
    return () => clearTimeout(timeout);
  }, [visibleKind, unhealthyBanner]);

  const isOpen = visible !== null;

  if (!isProviderHealthRecoverySurface(path)) {
    return null;
  }

  const handleFix = () => {
    if (chrome.kind !== "unhealthy") return;
    if (chrome.banner.zeroWorkingProviders) {
      navigate(ONBOARDING_PATH);
      return;
    }
    requestPluginsConnect(chrome.banner.provider);
    navigate(PLUGINS_PATH);
  };

  // A ready all-clear still mounts a zero-size marker so tests (and any
  // future chrome) can tell "actually healthy" from "unknown / not yet
  // polled" without treating empty DOM as healthy (CL-6834).
  if (chrome.kind === "healthy" && cachedVisible === null) {
    return <div data-provider-health="healthy" hidden />;
  }

  if (chrome.kind === "unknown" && cachedVisible === null) {
    return <div data-provider-health="unknown" hidden />;
  }

  return (
    <div
      className={`provider-health-banner-collapse${isOpen ? " is-open" : ""}`}
      data-provider-health={chrome.kind}
    >
      <div className="provider-health-banner-collapse-inner">
        {cachedVisible !== null ? (
          <div
            className="provider-health-banner"
            role={isOpen ? "alert" : undefined}
          >
            <Warning className="provider-health-banner-icon" aria-hidden />
            <p className="provider-health-banner-text">
              {cachedVisible.kind === "error"
                ? POLL_ERROR_COPY
                : bannerMessage(cachedVisible.banner)}
            </p>
            {cachedVisible.kind === "unhealthy" ? (
              <>
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
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
