import { useQuery } from "@tanstack/react-query";
import { getMeConnections } from "../lib/hub-api";

// Shares the Connections page's cache entry (apps/web/src/pages/Connections.tsx)
// so gating and the Connections page never disagree on connection state.
const ME_CONNECTIONS_KEY = ["me", "connections"] as const;

/** The caller's OAuth-connectable providers with their connection status —
 * the `credential-connected:<provider>` availability signal source consumed
 * by `PreferencesPanel` to gate settings like `tasksAutoSendAdapter`. */
export function useMeConnections() {
  return useQuery({
    queryKey: ME_CONNECTIONS_KEY,
    queryFn: getMeConnections,
    staleTime: 5 * 60_000,
  });
}
