import { useQuery } from "@tanstack/react-query";
import { MEMBER_CONNECTIONS_QUERY_KEY } from "../components/MemberConnectionsPanel";
import { getMeConnections } from "../lib/hub-api";

/** The caller's OAuth-connectable providers with their connection status —
 * the `credential-connected:<provider>` availability signal source consumed
 * by `PreferencesPanel` to gate settings like `tasksAutoSendAdapter`. */
export function useMeConnections() {
  return useQuery({
    queryKey: MEMBER_CONNECTIONS_QUERY_KEY,
    queryFn: getMeConnections,
    staleTime: 5 * 60_000,
  });
}
