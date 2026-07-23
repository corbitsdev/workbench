import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@workbench/ui";
import { adminTableCard } from "./admin-ui";
import { CredentialRow } from "./CredentialRow";
import type {
  OwnerCapabilityState,
  OwnerInboxSourcesResponse,
} from "@workbench/shared";
import {
  getOwnerCapabilities,
  getOwnerCredentials,
  getOwnerFeatures,
  getOwnerInboxSources,
  setOwnerCapabilityEnabled,
  setOwnerFeatureEnabled,
  setOwnerInboxSourceEnabled,
} from "../../lib/hub-api";

// Integrations/tools the workbench exposes with a dedicated sub-page. Add a
// new integration by appending here and mounting its sub-route — no other
// wiring. Providers without a dedicated config page (Granola, Exa, Firecrawl,
// Linear, GitHub, Attio) are rendered inline below as credential rows instead
// (see `CREDENTIAL_PROVIDER_CATALOG`'s `kind: "tool"` entries).
const CAPABILITIES = [
  {
    id: "gamma",
    name: "Gamma",
    description: "Presentation templates for agent-generated decks.",
    to: "/settings/owner/capabilities/gamma",
  },
] as const;

/**
 * Owner → Capabilities. The workbench's tools/integrations: Gamma configures
 * on its own sub-page; every other tool provider (CL-2879/CL-2883) is an
 * inline credential row here — configured/missing badge, write-only
 * "Set/Replace key", and Clear. Secrets are write-only end to end: the owner
 * pastes a key in and it is sent straight to the hub; every read only ever
 * sees masked configured/missing state, never the key itself.
 */
export function OwnerCapabilities() {
  const credentials = useQuery({
    queryKey: ["owner", "credentials"],
    queryFn: getOwnerCredentials,
    staleTime: 5 * 60_000,
  });
  const toolCredentials = credentials.data?.filter((c) => c.kind === "tool");

  const queryClient = useQueryClient();
  const [featureError, setFeatureError] = useState<string | null>(null);
  const features = useQuery({
    queryKey: ["owner", "features"],
    queryFn: getOwnerFeatures,
    staleTime: 5 * 60_000,
  });
  const toggleFeature = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setOwnerFeatureEnabled(name, enabled),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["owner", "features"] }),
    onError: () =>
      setFeatureError("Could not update the feature. Try again in a moment."),
  });

  const [inboxSourceError, setInboxSourceError] = useState<string | null>(null);
  const inboxSources = useQuery({
    queryKey: ["owner", "inbox-sources"],
    queryFn: getOwnerInboxSources,
    staleTime: 5 * 60_000,
  });
  const toggleInboxSource = useMutation<
    unknown,
    Error,
    { key: string; enabled: boolean },
    { previous: OwnerInboxSourcesResponse | undefined }
  >({
    mutationFn: ({ key, enabled }) => setOwnerInboxSourceEnabled(key, enabled),
    onMutate: async ({ key, enabled }) => {
      const queryKey = ["owner", "inbox-sources"];
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<OwnerInboxSourcesResponse>(queryKey);
      if (previous) {
        queryClient.setQueryData<OwnerInboxSourcesResponse>(queryKey, {
          sources: previous.sources.map((s) =>
            s.key === key ? { ...s, enabled } : s,
          ),
        });
      }
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["owner", "inbox-sources"], context.previous);
      }
      setInboxSourceError(
        "Could not update the inbox source. Try again in a moment.",
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["owner", "inbox-sources"] }),
  });

  const [oauthError, setOauthError] = useState<string | null>(null);
  const oauthCapabilities = useQuery({
    queryKey: ["owner", "capabilities"],
    queryFn: getOwnerCapabilities,
    staleTime: 5 * 60_000,
  });
  const toggleOauthCapability = useMutation({
    mutationFn: ({
      provider,
      enabled,
    }: {
      provider: string;
      enabled: boolean;
    }) => setOwnerCapabilityEnabled(provider, enabled),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["owner", "capabilities"] }),
    onError: () =>
      setOauthError("Could not update the capability. Try again in a moment."),
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">Features</h2>
        <p className="mb-2 text-sm text-text-2">
          Turn background routines on or off for this workbench.
        </p>
        {featureError && (
          <p className="mb-2 text-sm text-red" role="status">
            {featureError}
          </p>
        )}
        {features.isLoading ? (
          <p className="p-3 text-sm text-text-2">Loading…</p>
        ) : features.isError || !features.data ? (
          <p className="p-3 text-sm text-text-2">
            Could not load features. Try again in a moment.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {features.data.features.map((f) => {
                const statusId = `feature-status-${f.name}`;
                // Only the row whose write is in flight is disabled, not the
                // whole table — mutation.variables identifies which feature.
                const busy =
                  toggleFeature.isPending &&
                  toggleFeature.variables?.name === f.name;
                return (
                  <li
                    key={f.name}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">{f.label}</p>
                      <p className="mt-0.5 text-xs text-text-2">
                        {f.description}
                      </p>
                      <p id={statusId} className="mt-0.5 text-xs text-text-3">
                        {f.forcedByEnv
                          ? "Forced on by the deployment"
                          : f.enabled
                            ? "Enabled"
                            : "Disabled"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant={f.enabled ? "ghost" : "primary"}
                      size="sm"
                      disabled={busy || f.forcedByEnv}
                      title={
                        f.forcedByEnv
                          ? "Forced on by the deployment"
                          : undefined
                      }
                      aria-describedby={f.forcedByEnv ? statusId : undefined}
                      onClick={() => {
                        setFeatureError(null);
                        toggleFeature.mutate({
                          name: f.name,
                          enabled: !f.enabled,
                        });
                      }}
                    >
                      {f.enabled ? "Disable" : "Enable"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">Inbox sources</h2>
        <p className="mb-2 text-sm text-text-2">
          Which intake sources members may pull into their inbox. Disabling a
          source hides it from every member&apos;s Settings and stops all intake
          for it; re-enabling restores each member&apos;s previous choice.
        </p>
        {inboxSourceError && (
          <p className="mb-2 text-sm text-red" role="status">
            {inboxSourceError}
          </p>
        )}
        {inboxSources.isLoading ? (
          <p className="p-3 text-sm text-text-2">Loading…</p>
        ) : inboxSources.isError || !inboxSources.data ? (
          <p className="p-3 text-sm text-text-2">
            Could not load inbox sources. Try again in a moment.
          </p>
        ) : inboxSources.data.sources.length === 0 ? (
          <p className="p-3 text-sm text-text-2">
            No inbox sources are configurable for this workbench yet.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {inboxSources.data.sources.map((s) => {
                // Only the row whose write is in flight is disabled, not the
                // whole table — mutation.variables identifies which source.
                const busy =
                  toggleInboxSource.isPending &&
                  toggleInboxSource.variables?.key === s.key;
                return (
                  <li
                    key={s.key}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">{s.label}</p>
                      <p className="mt-0.5 text-xs text-text-2">
                        {s.description}
                      </p>
                      <p className="mt-0.5 text-xs text-text-3">
                        {s.enabled ? "Enabled" : "Disabled"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant={s.enabled ? "ghost" : "primary"}
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setInboxSourceError(null);
                        toggleInboxSource.mutate({
                          key: s.key,
                          enabled: !s.enabled,
                        });
                      }}
                    >
                      {s.enabled ? "Disable" : "Enable"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">
          Member connections
        </h2>
        <p className="mb-2 text-sm text-text-2">
          Which OAuth providers members can connect from Settings → Connections.
          Hiding a provider removes it from Settings → Connections for every
          member.
        </p>
        {oauthError && (
          <p className="mb-2 text-sm text-red" role="status">
            {oauthError}
          </p>
        )}
        {oauthCapabilities.isLoading ? (
          <p className="p-3 text-sm text-text-2">Loading…</p>
        ) : oauthCapabilities.isError || !oauthCapabilities.data ? (
          <p className="p-3 text-sm text-text-2">
            Could not load capabilities. Try again in a moment.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {oauthCapabilities.data.capabilities.map(
                (cap: OwnerCapabilityState) => {
                  // Only the row whose write is in flight is disabled, not
                  // the whole table — mutation.variables identifies which
                  // provider that is.
                  const busy =
                    toggleOauthCapability.isPending &&
                    toggleOauthCapability.variables?.provider === cap.provider;
                  return (
                    <li
                      key={cap.provider}
                      className="flex items-center justify-between gap-4 p-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text">
                          {cap.label}
                        </p>
                        <p className="mt-0.5 text-xs text-text-3">
                          {cap.enabled ? "Enabled" : "Hidden from members"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant={cap.enabled ? "ghost" : "primary"}
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setOauthError(null);
                          toggleOauthCapability.mutate({
                            provider: cap.provider,
                            enabled: !cap.enabled,
                          });
                        }}
                      >
                        {cap.enabled ? "Hide" : "Enable"}
                      </Button>
                    </li>
                  );
                },
              )}
            </ul>
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-sm text-text-2">
          Tools and integrations available in this workbench. Select Gamma to
          configure its templates.
        </p>
        <div className={adminTableCard}>
          <ul className="divide-y divide-border">
            {CAPABILITIES.map((cap) => (
              <li key={cap.id}>
                <Link
                  to={cap.to}
                  className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-page"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">{cap.name}</p>
                    <p className="mt-0.5 text-xs text-text-2">
                      {cap.description}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm text-text-3">
                    Configure →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-text">
          Integration credentials
        </h2>
        <p className="mb-2 text-sm text-text-2">
          Set or clear API keys for the other tools this workbench uses. Keys
          are write-only — once saved, the key itself is never shown again, only
          whether a provider is configured.
        </p>
        {credentials.isLoading ? (
          <p className="p-3 text-sm text-text-2">Loading…</p>
        ) : credentials.isError || !toolCredentials ? (
          <p className="p-3 text-sm text-text-2">
            Could not load credentials. Try again in a moment.
          </p>
        ) : toolCredentials.length === 0 ? (
          <p className="p-3 text-sm text-text-2">
            No other tool integrations are configurable for this workbench yet.
          </p>
        ) : (
          <div className={adminTableCard}>
            <ul className="divide-y divide-border">
              {toolCredentials.map((c) => (
                <CredentialRow key={c.providerName} credential={c} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
