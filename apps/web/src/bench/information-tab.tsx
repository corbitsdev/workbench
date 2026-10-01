import { Button, Skeleton, formatRelativeTime } from "@corbits/react-ui";
import { toast } from "@corbits/react-ui/ui/toast";
import { useQuery } from "@tanstack/react-query";
import { useContext, useState } from "react";

import { ArtifactListPageSchema, useAPIQuery } from "@/api";
import { IdentityAvatar } from "@/chat/avatar";
import type { WorkbenchParticipant } from "@/chat/threads-api";
import { libraryArtifactPath } from "@/library";
import { FileText, FlowArrow, Lightning } from "@/lib/icons";
import { Link } from "@/navigation";
import { ARTIFACTS_PATH_PREFIX, SKILLS_PATH_PREFIX, WORKFLOWS_PATH_PREFIX } from "@/path-ids";
import { tenantKeys } from "@/query-client";
import { routineDetailPath } from "@/global-routines";
import { scheduleSentence } from "@/pages/routines-page";
import { listScheduledWorkflows } from "@/routines-api";
import { skillDisplayName } from "@/skill-display-name";
import { listSkills } from "@/skills-api";
import { principalLabel } from "../settings/identity";
import { listPrincipals } from "../settings/tenancy-api";
import { WorkbenchSchedulesPanel } from "../pages/workbench-schedules-panel";
import { usePendingApprovals } from "../pending-approvals";
import { benchLink } from "../shell/page-crumbs";
import type { WorkerStatus } from "../worker-status";
import { DrawerTabContext } from "./bench-drawer";
import "./description.css";
import { DESCRIPTION_MAX, useBenchDescription } from "./description";
import { DEFAULT_WORKER_NAME, WORKER_NAME_MAX, useWorkerName } from "./worker-name";

function Section({
  title,
  action,
  onAction,
  children,
}: {
  readonly title: string;
  readonly action?: { readonly to: string; readonly label: string };
  /** A head button, for an action that stays in the drawer. */
  readonly onAction?: { readonly onClick: () => void; readonly label: string };
  readonly children: React.ReactNode;
}) {
  return (
    <section className="drawer-sec">
      <div className="drawer-sec-head">
        <h3>{title}</h3>
        {action === undefined ? null : <Link to={action.to}>{action.label}</Link>}
        {onAction === undefined ? null : (
          <button type="button" onClick={onAction.onClick}>
            {onAction.label}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function AboutSection({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const { description, save } = useBenchDescription(workbenchTenantId);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const dirty = draft !== null && draft.trim() !== description;
  if (!editing) {
    return (
      <Section
        title="About"
        onAction={{
          label: description === "" ? "Add" : "Edit",
          onClick: () => setDraft(description),
        }}
      >
        <p className="drawer-about">{description === "" ? "No description yet." : description}</p>
      </Section>
    );
  }
  return (
    <Section title="About" onAction={{ label: "Cancel", onClick: () => setDraft(null) }}>
      <form
        className="bench-description-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(draft.trim(), {
            onSuccess: () => setDraft(null),
            onError: (cause) => toast(cause instanceof Error ? cause.message : String(cause)),
          });
        }}
      >
        <textarea
          aria-label="Description"
          placeholder="Add a description"
          maxLength={DESCRIPTION_MAX}
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="bench-description-actions">
          <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
            Save
          </Button>
          <span className="bench-description-count">
            {draft.length}/{DESCRIPTION_MAX}
          </span>
        </div>
      </form>
    </Section>
  );
}

function MembersSummary({
  workbenchTenantId,
  participants,
}: {
  readonly workbenchTenantId: string;
  readonly participants: readonly WorkbenchParticipant[];
}) {
  const setTab = useContext(DrawerTabContext);
  // Same key as the Members tab so the two share one fetch.
  const people = useQuery({
    queryKey: [...tenantKeys.principals(workbenchTenantId), "members"],
    queryFn: async () => (await listPrincipals(workbenchTenantId)).filter((p) => p.kind === "user"),
  });
  const workers = participants.filter((p) => p.kind === "agent");
  const humans = people.data ?? [];
  const workersText = `${workers.length} worker${workers.length === 1 ? "" : "s"}`;
  const peopleText = humans.length === 1 ? "1 person" : `${humans.length} people`;
  return (
    <Section title="Members" onAction={{ label: "Manage", onClick: () => setTab("Members") }}>
      <div className="drawer-li" style={{ cursor: "default" }}>
        <span className="drawer-stack">
          {workers.map((w) => (
            <IdentityAvatar key={w.id} kind="agent" name={w.name} principalId={w.id} />
          ))}
          {humans.map((p) => (
            <IdentityAvatar
              key={p.id}
              kind="person"
              name={principalLabel(p.displayName).label}
              principalId={p.id}
            />
          ))}
        </span>
        <span className="drawer-li-t">
          <span>
            {workersText}, {peopleText}
          </span>
        </span>
      </div>
    </Section>
  );
}

function WorkerNameSection({ workbenchTenantId }: { readonly workbenchTenantId: string }) {
  const { name, save } = useWorkerName(workbenchTenantId);
  const current = name ?? DEFAULT_WORKER_NAME;
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current;
  const dirty = draft !== null && draft.trim() !== current;
  return (
    <Section title="Worker">
      <form
        className="bench-description-form"
        data-inline
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(value.trim(), {
            onSuccess: () => setDraft(null),
            onError: (cause) => toast(cause instanceof Error ? cause.message : String(cause)),
          });
        }}
      >
        <input
          aria-label="Worker name"
          maxLength={WORKER_NAME_MAX}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          Rename
        </Button>
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

  const skills = useQuery({
    queryKey: tenantKeys.skills(workbenchTenantId),
    queryFn: () => listSkills(workbenchTenantId),
  });
  const shownSkills = (skills.data ?? []).slice(0, 2);

  return (
    <>
      <AboutSection workbenchTenantId={workbenchTenantId} />
      <WorkerNameSection workbenchTenantId={workbenchTenantId} />

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
        {approvalsQuery.kind === "loading" ? <Skeleton className="skeleton-card" /> : null}
        {approvalsQuery.kind === "error" ? (
          <p className="workbench-info-empty-note">{approvalsQuery.message}</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length === 0 ? (
          <p className="workbench-info-empty-note">Nothing is waiting on you.</p>
        ) : null}
        {pendingApprovals !== null && pendingApprovals.length > 0 ? (
          <div className="drawer-list">
            {pendingApprovals.map((item) => (
              <div key={item.id} className="drawer-li">
                <IdentityAvatar
                  kind="agent"
                  name={item.agentName}
                  principalId={item.agentAddress}
                />
                <span className="drawer-li-t">
                  <b>{item.headline}</b>
                  <span>
                    {item.agentName}
                    {item.toolName === undefined ? "" : ` · ${item.toolName}`}
                  </span>
                </span>
                <span className="drawer-pill">Waiting</span>
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      <WorkbenchSchedulesPanel workbenchTenantId={workbenchTenantId} participants={participants} />

      <Section
        title="Active workflows"
        action={{ to: benchLink(WORKFLOWS_PATH_PREFIX, workbenchTenantId), label: "View all" }}
      >
        {flows.isLoading ? <Skeleton className="skeleton-row" /> : null}
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
        {artifacts.kind === "loading" ? <Skeleton className="skeleton-row" /> : null}
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

      <MembersSummary workbenchTenantId={workbenchTenantId} participants={participants} />

      <Section
        title="Skills"
        action={{ to: benchLink(SKILLS_PATH_PREFIX, workbenchTenantId), label: "View all" }}
      >
        {skills.isLoading ? <Skeleton className="skeleton-row" /> : null}
        {skills.isSuccess && shownSkills.length === 0 ? (
          <p className="workbench-info-empty-note">No skills here yet.</p>
        ) : null}
        <div className="drawer-list">
          {shownSkills.map((skill) => (
            <Link
              key={skill.assetId}
              to={`${SKILLS_PATH_PREFIX}/${encodeURIComponent(skill.name)}`}
              className="drawer-li"
            >
              <Lightning size={16} aria-hidden="true" />
              <span className="drawer-li-t">
                <b>{skillDisplayName(skill)}</b>
              </span>
            </Link>
          ))}
        </div>
      </Section>
    </>
  );
}
