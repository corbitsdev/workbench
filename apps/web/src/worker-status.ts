// The one status source for a worker. The inbox stream (see
// `subscribeToInbox`) writes into the participants and approvals caches this
// reads; nothing here fetches on its own.

import { useQuery } from "@tanstack/react-query";

import type { AvatarStatus } from "@/chat/avatar";
import { sameAddress, type WorkbenchParticipant } from "@/chat/threads-api";
import { workbenchKeys } from "./chat-path";
import { TenantApprovalsSchema, useAPIQuery } from "./api";
import { pendingApprovalsPath } from "./pending-approvals";

export type WorkerStatus = {
  readonly tone: AvatarStatus;
  readonly text: string;
};

// `working` has no stock signal: the inbox stream carries no turn events, and
// a live agent's run stays `running` whether or not a turn is in flight.
export function useWorkerStatus(
  tenantId: string | null,
  agentId: string | undefined,
): WorkerStatus {
  const participants = useQuery({
    queryKey: workbenchKeys.participants(tenantId ?? ""),
    queryFn: (): readonly WorkbenchParticipant[] => [],
    enabled: false,
  });
  const approvals = useAPIQuery(
    tenantId === null ? "" : pendingApprovalsPath(tenantId),
    TenantApprovalsSchema,
  );

  const agent = participants.data?.find((p) => p.kind === "agent" && p.id === agentId);
  if (agent === undefined) return { tone: "idle", text: "Live" };
  if (agent.address === "") return { tone: "idle", text: "Starting" };

  const needsYou =
    approvals.kind === "ready" &&
    approvals.data.data.some(
      (row) => row.status === "pending" && sameAddress(row.agentAddress, agent.address),
    );
  return needsYou ? { tone: "ready", text: "Needs you" } : { tone: "idle", text: "Live" };
}
