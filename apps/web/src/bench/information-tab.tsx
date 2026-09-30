import { Skeleton, formatRelativeTime } from "@corbits/react-ui";

import { ApprovalRow } from "@/chat/approval-row";
import { IdentityAvatar } from "@/chat/avatar";
import {
  resolveParticipantName,
  type WorkbenchMessage,
  type WorkbenchParticipant,
} from "@/chat/threads-api";
import { WorkbenchSchedulesPanel } from "../pages/workbench-schedules-panel";
import { usePendingApprovals } from "../pending-approvals";

/** Overview of the bench: latest activity, what's waiting on the person,
 * running schedules, and who is in it. */
export function InformationTab({
  workbenchTenantId,
  latestMessage,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly latestMessage: WorkbenchMessage | undefined;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const anyAgentStarting = participants.some(
    (p) => p.kind === "agent" && p.address === "",
  );
  const approvalsQuery = usePendingApprovals(workbenchTenantId, {
    refetchInterval: anyAgentStarting ? 3000 : false,
  });
  const pendingApprovals =
    approvalsQuery.kind === "ready" ? approvalsQuery.data : null;

  return (
    <>
      <section className="workbench-info-panel">
        <div className="workbench-info-panel-header">
          <h2>Latest activity</h2>
        </div>
        {latestMessage === undefined ? (
          <p className="workbench-info-empty-note">
            Nothing yet — say something to get started.
          </p>
        ) : (
          <p className="workbench-info-cell-context">
            {resolveParticipantName(latestMessage, participants)} ·{" "}
            {formatRelativeTime(latestMessage.at)}
          </p>
        )}
      </section>

      <section className="workbench-info-panel">
        <div className="workbench-info-panel-header">
          <h2>Approvals</h2>
        </div>
        {approvalsQuery.kind === "loading" ? (
          <Skeleton className="h-16 w-full" />
        ) : null}
        {approvalsQuery.kind === "error" ? (
          <p className="workbench-info-empty-note">{approvalsQuery.message}</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length === 0 ? (
          <p className="workbench-info-empty-note">Nothing waiting on you.</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length > 0 ? (
          <ul className="workbench-info-approval-list">
            {pendingApprovals.map((item) => (
              <ApprovalRow
                key={item.id}
                item={item}
                tenantId={workbenchTenantId}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <WorkbenchSchedulesPanel
        workbenchTenantId={workbenchTenantId}
        participants={participants}
      />

      <section className="workbench-info-panel">
        <div className="workbench-info-panel-header">
          <h2>Participants</h2>
        </div>
        <ul className="workbench-participants" aria-label="In this workbench">
          {participants.map((participant) => (
            <li key={participant.id} data-kind={participant.kind}>
              <span className="shell-ch-avatar">
                <IdentityAvatar
                  kind={participant.kind}
                  name={participant.name}
                  principalId={participant.id}
                />
              </span>
              {participant.name}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
