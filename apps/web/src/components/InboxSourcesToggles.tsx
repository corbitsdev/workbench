import { Link } from "react-router";
import { Select, Toggle } from "@workbench/settings";
import {
  LINEAR_BACKFILL_OPTIONS,
  LINEAR_BACKFILL_PREFERENCE_KEY,
  LINEAR_SCOPE_OPTIONS,
  LINEAR_SCOPE_PREFERENCE_KEY,
  OAUTH_PROVIDER_CATALOG,
  type AvailableInboxSource,
  type MemberConnectionState,
} from "@workbench/shared";
import { useMeConnections } from "../hooks/use-me-connections";
import {
  useInboxSources,
  usePreferenceSettings,
  useUpdateInboxSource,
  useUpdatePreference,
} from "../hooks/use-preference-settings";

const OAUTH_PROVIDER_NAMES = new Set(
  OAUTH_PROVIDER_CATALOG.map((p) => p.providerName),
);

type ConnectionStatus =
  | { readonly kind: "connected-oauth" }
  | { readonly kind: "workspace-key" }
  | { readonly kind: "needs-connection" };

function resolveConnectionStatus(
  source: AvailableInboxSource,
  connections: readonly MemberConnectionState[] | undefined,
): ConnectionStatus {
  if (!OAUTH_PROVIDER_NAMES.has(source.key)) {
    return { kind: "workspace-key" };
  }
  const connection = connections?.find((c) => c.provider === source.key);
  if (connection?.connected) {
    return { kind: "connected-oauth" };
  }
  return { kind: "needs-connection" };
}

function ConnectionStatusLabel({
  status,
}: {
  readonly status: ConnectionStatus;
}) {
  if (status.kind === "connected-oauth") {
    return <span className="text-xs text-text-3">Connected via OAuth</span>;
  }
  if (status.kind === "workspace-key") {
    return <span className="text-xs text-text-3">Using workspace key</span>;
  }
  return (
    <Link
      to="/settings/connections"
      className="text-xs font-medium text-orange hover:underline"
    >
      Connect your account
    </Link>
  );
}

interface LinearOptionsProps {
  readonly scope: string;
  readonly backfill: string;
  readonly onScopeChange: (value: string) => void;
  readonly onBackfillChange: (value: string) => void;
}

function LinearOptions({
  scope,
  backfill,
  onScopeChange,
  onBackfillChange,
}: LinearOptionsProps) {
  return (
    <div className="mt-1 flex flex-col gap-3 border-t border-border pt-3">
      <div>
        <label
          htmlFor="linear-source-scope"
          className="text-xs font-medium text-text-2"
        >
          What counts as activity
        </label>
        <Select
          id="linear-source-scope"
          className="mt-1"
          value={scope}
          onChange={(event) => onScopeChange(event.target.value)}
        >
          {LINEAR_SCOPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label
          htmlFor="linear-source-backfill"
          className="text-xs font-medium text-text-2"
        >
          Backfill on enable
        </label>
        <Select
          id="linear-source-backfill"
          className="mt-1"
          value={backfill}
          onChange={(event) => onBackfillChange(event.target.value)}
        >
          {LINEAR_BACKFILL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-text-3">
          Applies once, the first time you turn Linear on.
        </p>
      </div>
    </div>
  );
}

/**
 * Renders one card per inbox source the caller's tenant has a configured
 * credential for — identity, what enabling it does, connection status, and
 * the toggle (CL-3577 redesign). Driven entirely by `GET /me/inbox-sources` —
 * independent of `BriefSourcesToggles`: toggling a source here never changes
 * whether it feeds the daily brief, and vice versa. A source the owner has
 * disabled for the tenant is filtered out server-side and never rendered
 * here. Sources without a configured credential never render either.
 */
export function InboxSourcesToggles() {
  const query = useInboxSources();
  const update = useUpdateInboxSource();
  const connections = useMeConnections();
  const settingsQuery = usePreferenceSettings();
  const updatePreference = useUpdatePreference();

  if (query.isPending || query.isError) {
    return null;
  }

  const sources = query.data;
  if (sources.length === 0) {
    return null;
  }

  const linearScope =
    settingsQuery.data?.find((s) => s.key === LINEAR_SCOPE_PREFERENCE_KEY)
      ?.value ?? "assigned";
  const linearBackfill =
    settingsQuery.data?.find((s) => s.key === LINEAR_BACKFILL_PREFERENCE_KEY)
      ?.value ?? "none";

  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
      <div>
        <h3 className="text-sm font-semibold text-text">In your inbox</h3>
        <p className="mt-0.5 text-xs text-text-3">
          Turn on a source to have its activity land in your inbox.
        </p>
      </div>
      <div className="rounded-[10px] border border-border">
        <ul className="divide-y divide-border">
          {sources.map((source) => {
            const status = resolveConnectionStatus(
              source,
              connections.data?.connections,
            );
            const controlId = `inbox-source-${source.key}`;
            return (
              <li key={source.key} className="flex flex-col gap-2 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <label
                      htmlFor={controlId}
                      className="text-sm font-medium text-text"
                    >
                      {source.label}
                    </label>
                    <p className="mt-0.5 text-xs text-text-3">
                      {source.description}
                    </p>
                  </div>
                  <Toggle
                    id={controlId}
                    aria-label={source.label}
                    checked={source.enabled}
                    onCheckedChange={(checked) =>
                      update.mutate({ key: source.key, enabled: checked })
                    }
                  />
                </div>
                <ConnectionStatusLabel status={status} />
                {source.key === "linear" && source.enabled && (
                  <LinearOptions
                    scope={
                      typeof linearScope === "string" ? linearScope : "assigned"
                    }
                    backfill={
                      typeof linearBackfill === "string"
                        ? linearBackfill
                        : "none"
                    }
                    onScopeChange={(value) =>
                      updatePreference.mutate({
                        key: LINEAR_SCOPE_PREFERENCE_KEY,
                        value,
                      })
                    }
                    onBackfillChange={(value) =>
                      updatePreference.mutate({
                        key: LINEAR_BACKFILL_PREFERENCE_KEY,
                        value,
                      })
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
