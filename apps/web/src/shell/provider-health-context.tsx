// The shell's provider-health state (CL-6092): polls
// `GET .../connections/provider-health` for the selected bench and turns
// it into the one banner-worthy provider (if any), plus the Plugins deep
// link intent that hands a provider id from the banner's "Fix it" click
// to `PluginsRoute`'s own connect panel.
//
// Lives above both `AppShell` (which renders the banner) and the routed
// page (`PluginsRoute`, a sibling under `AppShell`'s children in
// `app.tsx`'s `Shell`) — the same reason `ShellChromeProvider` owns
// canvas state up here rather than scoped to one subtree.
//
// Dismissal is per-incident, not per-provider: dismissing an unhealthy
// provider's banner remembers the record's own `at` timestamp, so a
// *new* failure for the same provider (a later `at`) shows the banner
// again — matching CL-6092's "reappears on a new failure" rule.
//
// Poll status (CL-6834): empty `providers` alone is not "all healthy".
// The chrome distinguishes `unknown` (no successful poll yet), `error`
// (first-load / never-ready poll failure), and `ready` (a snapshot has
// landed). A failed poll after `ready` keeps last-known providers on
// screen; a failed poll before any success becomes `error` so the
// chrome can show unknown/error rather than a silent all-clear.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  fetchProviderHealth,
  type ClassifiedInferenceFailureCategory,
  type ProviderHealthRecord,
} from "@corbits/connections/provider-health";

import { useBench } from "../bench-context";

const POLL_INTERVAL_MS = 30_000;

export type ProviderHealthBannerState = {
  readonly provider: string;
  readonly category: ClassifiedInferenceFailureCategory;
  /** True when the tenant has no working provider at all — the banner's
   * fix action routes to onboarding's credential step instead of
   * Plugins in this case. */
  readonly zeroWorkingProviders: boolean;
};

/** Whether the shell has a usable health snapshot yet (CL-6834). */
export type ProviderHealthPollStatus = "unknown" | "ready" | "error";

/**
 * What health chrome should present — never collapse "no snapshot yet"
 * or "poll failed" into the same silence as "ready and nothing unhealthy".
 */
export type ProviderHealthChrome =
  | { readonly kind: "unknown" }
  | { readonly kind: "error" }
  | { readonly kind: "healthy" }
  | {
      readonly kind: "unhealthy";
      readonly banner: ProviderHealthBannerState;
    };

type ProviderHealthContextValue = {
  readonly status: ProviderHealthPollStatus;
  readonly banner: ProviderHealthBannerState | null;
  readonly dismissBanner: () => void;
  readonly pendingConnectProvider: string | null;
  readonly requestPluginsConnect: (provider: string) => void;
  readonly clearPendingConnectProvider: () => void;
};

const ProviderHealthContext = createContext<ProviderHealthContextValue | null>(
  null,
);

function firstUnhealthyProvider(
  providers: Readonly<Record<string, ProviderHealthRecord>>,
): { provider: string; record: ProviderHealthRecord } | null {
  const entries = Object.entries(providers);
  if (entries.length === 0) return null;
  const [provider, record] = entries.sort(([, a], [, b]) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : 0,
  )[0] as [string, ProviderHealthRecord];
  return { provider, record };
}

/**
 * Pure banner-selection logic (CL-6092), split out from
 * `ProviderHealthProvider`'s state wiring so it is unit-testable without
 * mounting React: picks the most recently reported unhealthy provider,
 * skips it if the person already dismissed *this exact incident*
 * (`dismissedAt[provider] === record.at`) — a later `at` for the same
 * provider is a new incident and shows again — and marks
 * `zeroWorkingProviders` only when the connected-provider count is
 * known and exactly zero (never when it's unknown/undefined, so a
 * caller with no lister wired never gets routed to onboarding by
 * mistake).
 */
export function deriveProviderHealthBanner(
  providers: Readonly<Record<string, ProviderHealthRecord>>,
  dismissedAt: Readonly<Record<string, string>>,
  connectedProviderCount: number | undefined,
): ProviderHealthBannerState | null {
  const unhealthy = firstUnhealthyProvider(providers);
  if (unhealthy === null) return null;
  if (dismissedAt[unhealthy.provider] === unhealthy.record.at) return null;
  return {
    provider: unhealthy.provider,
    category: unhealthy.record.category,
    zeroWorkingProviders: connectedProviderCount === 0,
  };
}

/**
 * Next poll-status after one fetch outcome (CL-6834). Success always
 * becomes `ready`. Failure before any success becomes `error` (so empty
 * providers are not read as healthy). Failure after `ready` stays
 * `ready` so last-known state remains on screen for the next retry.
 */
export function nextProviderHealthPollStatus(
  current: ProviderHealthPollStatus,
  outcome: "ok" | "fail",
): ProviderHealthPollStatus {
  if (outcome === "ok") return "ready";
  if (current === "ready") return "ready";
  return "error";
}

/**
 * Maps poll status + the (possibly null) unhealthy banner into chrome
 * the shell can render. Empty providers under `unknown`/`error` are
 * never `healthy` (CL-6834).
 */
export function deriveProviderHealthChrome(
  status: ProviderHealthPollStatus,
  banner: ProviderHealthBannerState | null,
): ProviderHealthChrome {
  if (status === "unknown") return { kind: "unknown" };
  if (status === "error") return { kind: "error" };
  if (banner === null) return { kind: "healthy" };
  return { kind: "unhealthy", banner };
}

export function ProviderHealthProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { selectedTenantId } = useBench();
  const [providers, setProviders] = useState<
    Readonly<Record<string, ProviderHealthRecord>>
  >({});
  const [connectedProviderCount, setConnectedProviderCount] = useState<
    number | undefined
  >(undefined);
  const [status, setStatus] = useState<ProviderHealthPollStatus>("unknown");
  // Keyed by provider, remembers the `at` of the incident a person last
  // dismissed — so a later `at` for the same provider is a NEW incident,
  // not a re-show of one already acknowledged.
  const [dismissedAt, setDismissedAt] = useState<
    Readonly<Record<string, string>>
  >({});
  const [pendingConnectProvider, setPendingConnectProvider] = useState<
    string | null
  >(null);

  const tenantIdRef = useRef(selectedTenantId);
  tenantIdRef.current = selectedTenantId;
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (selectedTenantId === null) {
      setProviders({});
      setConnectedProviderCount(undefined);
      setStatus("unknown");
      statusRef.current = "unknown";
      return;
    }
    let cancelled = false;
    setStatus("unknown");
    statusRef.current = "unknown";
    setProviders({});
    setConnectedProviderCount(undefined);
    const poll = () => {
      fetchProviderHealth(selectedTenantId)
        .then((snapshot) => {
          if (cancelled || tenantIdRef.current !== selectedTenantId) return;
          setProviders(snapshot.providers);
          setConnectedProviderCount(snapshot.connectedProviderCount);
          const next = nextProviderHealthPollStatus(statusRef.current, "ok");
          statusRef.current = next;
          setStatus(next);
        })
        .catch(() => {
          if (cancelled || tenantIdRef.current !== selectedTenantId) return;
          // First-load failure → error (empty providers must not look
          // healthy). After a successful poll, leave last-known providers
          // and stay ready — the next interval retries.
          const next = nextProviderHealthPollStatus(statusRef.current, "fail");
          statusRef.current = next;
          setStatus(next);
        });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedTenantId]);

  const dismissBanner = useCallback(() => {
    const unhealthy = firstUnhealthyProvider(providers);
    if (unhealthy === null) return;
    setDismissedAt((state) => ({
      ...state,
      [unhealthy.provider]: unhealthy.record.at,
    }));
  }, [providers]);

  const requestPluginsConnect = useCallback((provider: string) => {
    setPendingConnectProvider(provider);
  }, []);

  const clearPendingConnectProvider = useCallback(() => {
    setPendingConnectProvider(null);
  }, []);

  const banner =
    status === "ready"
      ? deriveProviderHealthBanner(
          providers,
          dismissedAt,
          connectedProviderCount,
        )
      : null;

  return (
    <ProviderHealthContext.Provider
      value={{
        status,
        banner,
        dismissBanner,
        pendingConnectProvider,
        requestPluginsConnect,
        clearPendingConnectProvider,
      }}
    >
      {children}
    </ProviderHealthContext.Provider>
  );
}

function useProviderHealthContext(): ProviderHealthContextValue {
  const value = useContext(ProviderHealthContext);
  if (value === null) {
    throw new Error(
      "provider health hooks used outside ProviderHealthProvider",
    );
  }
  return value;
}

export function useProviderHealthBanner(): ProviderHealthBannerState | null {
  return useProviderHealthContext().banner;
}

/** Poll readiness (CL-6834) — consumers that used to treat a null banner
 * as "all healthy" must check this: `unknown`/`error` are not healthy. */
export function useProviderHealthStatus(): ProviderHealthPollStatus {
  return useProviderHealthContext().status;
}

/** Chrome discriminant (CL-6834) — unknown / error / healthy / unhealthy. */
export function useProviderHealthChrome(): ProviderHealthChrome {
  const { status, banner } = useProviderHealthContext();
  return deriveProviderHealthChrome(status, banner);
}

export function useDismissProviderHealthBanner(): () => void {
  return useProviderHealthContext().dismissBanner;
}

export function useRequestPluginsConnect(): (provider: string) => void {
  return useProviderHealthContext().requestPluginsConnect;
}

/** The pending deep-link provider id the banner's "Fix it" click set, if
 * any — reactive, so `PluginsRoute`'s effect re-fires the moment a click
 * sets it, even if the gallery had already finished loading. */
export function usePendingConnectProvider(): string | null {
  return useProviderHealthContext().pendingConnectProvider;
}

/** `PluginsRoute` calls this once it has acted on (or given up finding a
 * match for) a pending deep-link provider id, so it is not re-consumed
 * on a later re-render. */
export function useClearPendingConnectProvider(): () => void {
  return useProviderHealthContext().clearPendingConnectProvider;
}
