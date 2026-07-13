import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@workbench/ui";
import { authorizeMeConnection, getMeConnections } from "../lib/hub-api";

const CONNECTIONS_QUERY_KEY = ["me", "connections"];

function describeConnectError(reason: string | null): string {
  if (reason === "denied") return "You declined the connection request.";
  if (reason === "expired")
    return "The connection request expired. Try connecting again.";
  return "Could not complete the connection. Try again in a moment.";
}

/**
 * Settings → Connections (CL-3356/CL-3451). Lists the OAuth providers the
 * caller is granted, their connected state, and lets them start/redo the
 * connect flow. The token itself is never fetched or shown here.
 */
export function Connections() {
  const [searchParams, setSearchParams] = useSearchParams();
  const connectedProvider = searchParams.get("connected");
  const connectError = searchParams.get("connect_error");
  const [authorizeError, setAuthorizeError] = useState<string | null>(null);

  const connections = useQuery({
    queryKey: CONNECTIONS_QUERY_KEY,
    queryFn: getMeConnections,
    staleTime: 5 * 60_000,
  });

  const queryClient = useQueryClient();
  const authorize = useMutation({
    mutationFn: authorizeMeConnection,
    onSuccess: ({ redirectUrl }) => {
      window.location.assign(redirectUrl);
    },
    onError: () =>
      setAuthorizeError(
        "Could not start the connection. Try again in a moment.",
      ),
  });

  function dismissBanner() {
    const next = new URLSearchParams(searchParams);
    next.delete("connected");
    next.delete("connect_error");
    setSearchParams(next, { replace: true });
    void queryClient.invalidateQueries({ queryKey: CONNECTIONS_QUERY_KEY });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text">Connections</h1>
          <p className="mt-0.5 text-sm text-text-3">
            Connect your accounts to bring outside data into the workbench.
          </p>
        </div>
        {connectedProvider && (
          <div
            role="status"
            className="mb-4 flex items-center justify-between gap-4 rounded-[10px] border border-border bg-page p-3 text-sm text-text"
          >
            <span>Connected {connectedProvider} successfully.</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={dismissBanner}
            >
              Dismiss
            </Button>
          </div>
        )}
        {connectError && (
          <div
            role="alert"
            className="mb-4 flex items-center justify-between gap-4 rounded-[10px] border border-red/40 bg-red/5 p-3 text-sm text-red"
          >
            <span>{describeConnectError(connectError)}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={dismissBanner}
            >
              Dismiss
            </Button>
          </div>
        )}
        {authorizeError && (
          <p className="mb-4 text-sm text-red" role="status">
            {authorizeError}
          </p>
        )}

        {connections.isLoading ? (
          <p className="p-3 text-sm text-text-2">Loading…</p>
        ) : connections.isError || !connections.data ? (
          <p className="p-3 text-sm text-text-2">
            Could not load connections. Try again in a moment.
          </p>
        ) : connections.data.connections.length === 0 ? (
          <p className="p-3 text-sm text-text-2">
            No connectable providers are available for your workbench yet.
          </p>
        ) : (
          <div className="rounded-[10px] border border-border">
            <ul className="divide-y divide-border">
              {connections.data.connections.map((conn) => {
                const statusId = `connection-status-${conn.provider}`;
                return (
                  <li
                    key={conn.provider}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text">
                        {conn.label}
                      </p>
                      <p id={statusId} className="mt-0.5 text-xs text-text-3">
                        {!conn.configured
                          ? "Not available — an owner must configure this provider's OAuth app on the Capabilities page."
                          : conn.needsReconnect
                            ? "Needs reconnect"
                            : conn.connected
                              ? "Connected"
                              : "Not connected"}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant={
                        conn.connected && !conn.needsReconnect
                          ? "ghost"
                          : "primary"
                      }
                      size="sm"
                      disabled={!conn.configured || authorize.isPending}
                      aria-describedby={statusId}
                      title={
                        !conn.configured
                          ? "This provider's OAuth app is not configured yet"
                          : undefined
                      }
                      onClick={() => {
                        setAuthorizeError(null);
                        authorize.mutate(conn.provider);
                      }}
                    >
                      {conn.connected && !conn.needsReconnect
                        ? "Reconnect"
                        : "Connect"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default Connections;
