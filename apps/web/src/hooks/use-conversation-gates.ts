import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  pendingGateForRun,
  routeConversationSignal,
  type PendingGate,
  type SignalRouting,
} from "@workbench/chat";
import {
  fetchWorkflowRunState,
  useConversationWorkflowRuns,
  workflowRunStateQueryKey,
} from "./use-workflow";

// The HITL signal-routing verdict for a whole conversation (CL-2681).
//
// Derivation, in one reusable place (pairs with CL-2682): list the
// conversation's runs, read the log-derived state of every run parked on a gate
// (`status === "awaiting"`), recover each gate's `signalName` from the log, and
// fold the set through the shared `routeConversationSignal` rule —
//   0 gates → free text is a normal chat turn,
//   1 gate  → free text auto-routes to it,
//   >1 gate → free text does NOT auto-route; the human names a run / uses a card.
//
// State reads share the exact query key `useWorkflowRunState` uses, so a mounted
// dock card and this scan dedupe onto one poll rather than double-fetching. Only
// `awaiting` runs are read — a running/terminal run holds no gate.
export function useConversationGates(
  conversationId: string | null,
  tenantId?: string | null,
): SignalRouting {
  const { data: runs } = useConversationWorkflowRuns(conversationId, tenantId);

  const awaiting = useMemo(
    () => (runs ?? []).filter((run) => run.status === "awaiting"),
    [runs],
  );

  const stateQueries = useQueries({
    queries: awaiting.map((run) => ({
      queryKey: workflowRunStateQueryKey(run.runId, tenantId),
      queryFn: () => fetchWorkflowRunState(run.runId, tenantId),
      staleTime: 0,
      retry: false,
    })),
  });

  return useMemo(() => {
    const gates: PendingGate[] = [];
    for (let i = 0; i < awaiting.length; i++) {
      const run = awaiting[i];
      const log = stateQueries[i]?.data;
      if (run === undefined || log === undefined) continue;
      const gate = pendingGateForRun({
        runId: run.runId,
        runKind: run.kind,
        steps: log.steps,
      });
      if (gate !== null) gates.push(gate);
    }
    return routeConversationSignal(gates);
  }, [awaiting, stateQueries]);
}
