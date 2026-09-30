// The one status source for a worker. Stock Interchange has no live turn
// stream, so `working` is client-derived: a send records `pendingTurn` in the
// query cache, and it ends when a worker message newer than it lands, an
// approval is pending, or the safety timeout passes.

import { useEffect } from "react";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { AvatarStatus } from "@/chat/avatar";
import {
  listWorkbenchParticipants,
  readWorkbench,
  sameAddress,
  type WorkbenchMessage,
  type WorkbenchParticipant,
} from "@/chat/threads-api";
import { workbenchKeys } from "./chat-path";
import { TenantApprovalsSchema, apiQueryOptions } from "./api";
import { createFetchStockHub } from "./needs-converge";
import { pendingApprovalsPath } from "./pending-approvals";

export type WorkerStatus = {
  readonly tone: AvatarStatus;
  readonly text: string;
};

type PendingTurn = { readonly sentAt: number };
type Bench = { readonly id: string; readonly domain: string };

const PENDING_TURN_TIMEOUT_MS = 10 * 60 * 1000;
const PENDING_POLL_MS = 5000;

/** Call from a send mutation's `onMutate`. */
export function markTurnPending(queryClient: QueryClient, benchId: string): void {
  queryClient.setQueryData<PendingTurn>(workbenchKeys.pendingTurn(benchId), {
    sentAt: Date.now(),
  });
}

function turnAnswered(timeline: readonly WorkbenchMessage[] | undefined, sentAt: number): boolean {
  return (timeline ?? []).some((m) => m.author === "other" && Date.parse(m.at) > sentAt);
}

const RANK: Record<string, number> = { "Needs you": 3, Working: 2, Live: 1, Starting: 0 };

/** The status of the worker `isWorker` matches, across the given benches:
 * needs-you beats working beats live. */
export function useBenchWorkerStatus(
  benches: readonly Bench[],
  isWorker: (participant: WorkbenchParticipant) => boolean,
): WorkerStatus {
  const queryClient = useQueryClient();
  const participants = useQueries({
    queries: benches.map((bench) => ({
      queryKey: workbenchKeys.participants(bench.id),
      queryFn: () => listWorkbenchParticipants(bench.id, bench.domain),
      enabled: bench.domain !== "",
    })),
  });
  const approvals = useQueries({
    queries: benches.map((bench) => ({
      ...apiQueryOptions(pendingApprovalsPath(bench.id), TenantApprovalsSchema),
    })),
  });
  const pending = useQueries({
    queries: benches.map((bench) => ({
      queryKey: workbenchKeys.pendingTurn(bench.id),
      queryFn: (): PendingTurn | null => null,
      enabled: false,
      gcTime: Infinity,
    })),
  });
  const timelines = useQueries({
    queries: benches.map((bench, index) => ({
      queryKey: workbenchKeys.timeline(bench.id),
      queryFn: () => readWorkbench(bench.id),
      enabled: pending[index]?.data != null,
      refetchInterval: PENDING_POLL_MS,
    })),
  });

  let best: WorkerStatus | undefined;
  const offer = (status: WorkerStatus) => {
    if (best === undefined || (RANK[status.text] ?? 0) > (RANK[best.text] ?? 0)) best = status;
  };
  const now = Date.now();
  const expiries: { id: string; at: number }[] = [];

  benches.forEach((bench, index) => {
    const agent = participants[index]?.data?.find((p) => p.kind === "agent" && isWorker(p));
    if (agent === undefined) return;
    if (agent.address === "") return offer({ tone: "idle", text: "Starting" });
    const needsYou = (approvals[index]?.data?.data ?? []).some(
      (row) => row.status === "pending" && sameAddress(row.agentAddress, agent.address),
    );
    if (needsYou) return offer({ tone: "ready", text: "Needs you" });
    const sentAt = pending[index]?.data?.sentAt;
    if (sentAt !== undefined) {
      expiries.push({ id: bench.id, at: sentAt + PENDING_TURN_TIMEOUT_MS });
      if (now < sentAt + PENDING_TURN_TIMEOUT_MS && !turnAnswered(timelines[index]?.data, sentAt)) {
        return offer({ tone: "working", text: "Working…" });
      }
    }
    offer({ tone: "idle", text: "Live" });
  });

  // Ends a turn by dropping its entry; a timer covers the timeout when no
  // other signal arrives.
  const settled = benches
    .map((bench, index) => {
      const sentAt = pending[index]?.data?.sentAt;
      const approved = (approvals[index]?.data?.data ?? []).some((row) => row.status === "pending");
      return sentAt !== undefined && (approved || turnAnswered(timelines[index]?.data, sentAt))
        ? bench.id
        : null;
    })
    .filter((id): id is string => id !== null);
  const settledKey = settled.join(",");
  const expiryKey = expiries.map((e) => `${e.id}:${e.at}`).join(",");
  useEffect(() => {
    for (const id of settledKey.split(",").filter(Boolean)) {
      queryClient.setQueryData(workbenchKeys.pendingTurn(id), null);
    }
  }, [settledKey, queryClient]);
  useEffect(() => {
    const timers = expiries.map(({ id, at }) =>
      setTimeout(
        () => queryClient.setQueryData(workbenchKeys.pendingTurn(id), null),
        Math.max(0, at - Date.now()),
      ),
    );
    return () => timers.forEach(clearTimeout);
    // `expiryKey` is the serialized `expiries`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiryKey, queryClient]);

  return best ?? { tone: "idle", text: "Live" };
}

export function useWorkerStatus(
  tenantId: string | null,
  agentId: string | undefined,
): WorkerStatus {
  const tenant = useQuery({
    queryKey: workbenchKeys.tenant(tenantId ?? ""),
    queryFn: () => createFetchStockHub().getTenant(tenantId ?? ""),
    enabled: tenantId !== null,
  });
  const benches = tenantId === null ? [] : [{ id: tenantId, domain: tenant.data?.domain ?? "" }];
  return useBenchWorkerStatus(benches, (p) => p.id === agentId);
}
