import { Button, Skeleton, formatRelativeTime } from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { ArtifactListPageSchema, useAPIQuery } from "@/api";
import { ApprovalRow } from "@/chat/approval-row";
import { IdentityAvatar } from "@/chat/avatar";
import type { WorkbenchParticipant } from "@/chat/threads-api";
import { libraryArtifactPath } from "@/library";
import { FileText, FlowArrow } from "@/lib/icons";
import { Link } from "@/navigation";
import { ARTIFACTS_PATH_PREFIX, WORKFLOWS_PATH_PREFIX } from "@/path-ids";
import { tenantKeys } from "@/query-client";
import { routineDetailPath } from "@/global-routines";
import { scheduleSentence } from "@/pages/routines-page";
import { listScheduledWorkflows } from "@/routines-api";
import { WorkbenchSchedulesPanel } from "../pages/workbench-schedules-panel";
import { usePendingApprovals } from "../pending-approvals";
import { benchLink } from "../shell/page-crumbs";
import type { WorkerStatus } from "../worker-status";
import "./description.css";
import { DESCRIPTION_MAX, useBenchDescription } from "./description";

function Section({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: { readonly to: string; readonly label: string };
  readonly children: React.ReactNode;
}) {
  return (
    <section className="drawer-sec">
      <div className="drawer-sec-head">
        <h3>{title}</h3>
        {action === undefined ? null : <Link to={action.to}>{action.label}</Link>}
      </div>
      {children}
    </section>
  );
}

function AboutSection({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const { description, save } = useBenchDescription(workbenchTenantId);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? description;
  const dirty = draft !== null && draft.trim() !== description;
  return (
    <Section title="About">
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
    </Section>
  );
}

/** Overview of the bench: what it is, what's happening now, what's waiting
 * on the person, and its live workflows and latest files. */
export function InformationTab({
  workbenchTenantId,
  worker,
  status,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly worker: WorkbenchParticipant | undefined;
  readonly status: WorkerStatus;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const anyAgentStarting = participants.some((p) => p.kind === "agent" && p.address === "");
  const approvalsQuery = usePendingApprovals(workbenchTenantId, {
    refetchInterval: anyAgentStarting ? 3000 : false,
  });
  const pendingApprovals = approvalsQuery.kind === "ready" ? approvalsQuery.data : null;

  const flows = useQuery({
    queryKey: tenantKeys.routines(workbenchTenantId),
    queryFn: () => listScheduledWorkflows(workbenchTenantId),
  });
  const liveFlows = (flows.data ?? []).filter((flow) => flow.status === "deployed");

  const artifacts = useAPIQuery(
    `/api/tenants/${workbenchTenantId}/artifacts`,
    ArtifactListPageSchema,
  );
  const latest =
    artifacts.kind === "ready"
      ? [...artifacts.data.artifacts]
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, 2)
      : [];

  return (
    <>
      <AboutSection workbenchTenantId={workbenchTenantId} />

      {worker !== undefined && status.tone === "working" ? (
        <Section title="Now">
          <div className="drawer-now">
            <IdentityAvatar
              kind="agent"
              name={worker.name}
              principalId={worker.id}
              status={status.tone}
            />
            <div>
              <b>{worker.name}</b>
              <span>{status.text}</span>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="Needs you">
        {approvalsQuery.kind === "loading" ? <Skeleton className="h-16 w-full" /> : null}
        {approvalsQuery.kind === "error" ? (
          <p className="workbench-info-empty-note">{approvalsQuery.message}</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length === 0 ? (
          <p className="workbench-info-empty-note">Nothing is waiting on you.</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length > 0 ? (
          <ul className="workbench-info-approval-list">
            {pendingApprovals.map((item) => (
              <ApprovalRow key={item.id} item={item} tenantId={workbenchTenantId} />
            ))}
          </ul>
        ) : null}
      </Section>

      <WorkbenchSchedulesPanel workbenchTenantId={workbenchTenantId} participants={participants} />

      <Section
        title="Active workflows"
        action={{ to: benchLink(WORKFLOWS_PATH_PREFIX, workbenchTenantId), label: "View all" }}
      >
        {flows.isLoading ? <Skeleton className="h-10 w-full" /> : null}
        {flows.isSuccess && liveFlows.length === 0 ? (
          <p className="workbench-info-empty-note">No workflows are running here.</p>
        ) : null}
        <div className="drawer-list">
          {liveFlows.map((flow) => (
            <Link
              key={flow.definitionId}
              to={routineDetailPath(flow.definitionId)}
              className="drawer-li"
            >
              <FlowArrow size={16} aria-hidden="true" />
              <span className="drawer-li-t">
                <b>{flow.name}</b>
                <span>{scheduleSentence(flow.schedule)}</span>
              </span>
            </Link>
          ))}
        </div>
      </Section>

      <Section
        title="Latest artifacts"
        action={{ to: benchLink(ARTIFACTS_PATH_PREFIX, workbenchTenantId), label: "View all" }}
      >
        {artifacts.kind === "loading" ? <Skeleton className="h-10 w-full" /> : null}
        {artifacts.kind === "ready" && latest.length === 0 ? (
          <p className="workbench-info-empty-note">Nothing saved here yet.</p>
        ) : null}
        <div className="drawer-list">
          {latest.map((artifact) => (
            <Link key={artifact.id} to={libraryArtifactPath(artifact.id)} className="drawer-li">
              <span className="drawer-file-ic">
                <FileText size={16} aria-hidden="true" />
              </span>
              <span className="drawer-li-t">
                <b>{artifact.title}</b>
                <span>{artifact.kind}</span>
              </span>
              <span className="drawer-li-m">{formatRelativeTime(artifact.updatedAt)}</span>
            </Link>
          ))}
        </div>
      </Section>
    </>
  );
}
