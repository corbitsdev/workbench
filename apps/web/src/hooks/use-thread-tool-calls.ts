import { useQuery } from "@tanstack/react-query";
import { hubFetch } from "../lib/hub-api";
import {
  parseThreadTurns,
  singleUnresolvedToolCall,
  type UnresolvedToolCall,
} from "../lib/unresolved-tool-call";

export const THREAD_TURNS_QUERY_KEY = "thread-turns";

async function fetchOpenThreadUnresolvedToolCall(
  tenantId: string,
  instanceId: string,
): Promise<UnresolvedToolCall | null> {
  const raw = await hubFetch<unknown>(
    "GET",
    `tenants/${tenantId}/agents/instances/${instanceId}/turns?limit=100`,
  );
  return singleUnresolvedToolCall(parseThreadTurns(raw));
}

/**
 * The single unresolved (approval-awaiting) tool call in the currently-open
 * chat thread, sourced from its transcript (CL-3940) so the native approval
 * card can show the real action + args the backend snapshot drops. Null when no
 * thread is open, or when the transcript yields zero or more than one candidate
 * (the no-mismatch guard in `singleUnresolvedToolCall`).
 *
 * ReviewGate invalidates this query alongside the native-approvals list on each
 * approval SSE event, so the call re-derives the instant an approval appears.
 */
export function useOpenThreadToolCall(
  tenantId: string,
  openInstanceId: string | null,
): UnresolvedToolCall | null {
  const query = useQuery({
    queryKey: [THREAD_TURNS_QUERY_KEY, tenantId, openInstanceId],
    enabled: tenantId !== "" && openInstanceId !== null,
    queryFn: () =>
      fetchOpenThreadUnresolvedToolCall(tenantId, openInstanceId ?? ""),
  });
  return query.data ?? null;
}
