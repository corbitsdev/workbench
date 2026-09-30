import { Button, Skeleton, formatRelativeTime, toast } from "@corbits/react-ui";
import { useState } from "react";

import { ApprovalRow } from "@/chat/approval-row";
import { IdentityAvatar } from "@/chat/avatar";
import {
  resolveParticipantName,
  type WorkbenchMessage,
  type WorkbenchParticipant,
} from "@/chat/threads-api";
import { WorkbenchSchedulesPanel } from "../pages/workbench-schedules-panel";
import { usePendingApprovals } from "../pending-approvals";
import "./description.css";
import { DESCRIPTION_MAX, useBenchDescription } from "./description";

function AboutSection({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const { description, save } = useBenchDescription(workbenchTenantId);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? description;
  const dirty = draft !== null && draft.trim() !== description;
  return (
    <section className="workbench-info-panel">
      <div className="workbench-info-panel-header">
        <h2>About</h2>
      </div>
      <form
        className="bench-description-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(value.trim(), {
            onSuccess: () => setDraft(null),
            onError: (cause) => toast(cause instanceof Error ? cause.message : String(cause)),
          });
        }}
      >
        <textarea
          aria-label="Description"
          placeholder="Add a description"
          maxLength={DESCRIPTION_MAX}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="bench-description-actions">
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            Save
          </Button>
          <span className="bench-description-count">
            {value.length}/{DESCRIPTION_MAX}
          </span>
        </div>
      </form>
    </section>
  );
}

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
  const anyAgentStarting = participants.some((p) => p.kind === "agent" && p.address === "");
  const approvalsQuery = usePendingApprovals(workbenchTenantId, {
    refetchInterval: anyAgentStarting ? 3000 : false,
  });
  const pendingApprovals = approvalsQuery.kind === "ready" ? approvalsQuery.data : null;

  return (
    <>
      <AboutSection workbenchTenantId={workbenchTenantId} />

      <section className="workbench-info-panel">
        <div className="workbench-info-panel-header">
          <h2>Latest activity</h2>
        </div>
        {latestMessage === undefined ? (
          <p className="workbench-info-empty-note">Nothing yet — say something to get started.</p>
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
        {approvalsQuery.kind === "loading" ? <Skeleton className="h-16 w-full" /> : null}
        {approvalsQuery.kind === "error" ? (
          <p className="workbench-info-empty-note">{approvalsQuery.message}</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length === 0 ? (
          <p className="workbench-info-empty-note">Nothing waiting on you.</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length > 0 ? (
          <ul className="workbench-info-approval-list">
            {pendingApprovals.map((item) => (
              <ApprovalRow key={item.id} item={item} tenantId={workbenchTenantId} />
            ))}
          </ul>
        ) : null}
      </section>

      <WorkbenchSchedulesPanel workbenchTenantId={workbenchTenantId} participants={participants} />

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
