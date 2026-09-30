// One section and nothing else: Workbenches. Agent membership is a
// workbench concept.

import { EmptyState, Skeleton } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";
import { WorkbenchAvatar } from "@/chat/avatar";
import { listChatAgents } from "@/chat/threads-api";
import { Hash } from "@/lib/icons";

import { useBench } from "../bench-context";
import { tenantKeys } from "../query-client";
import { workbenchIdFromPath, workbenchPath } from "../workbench-path";
import type { HubTenant } from "../needs-converge";
import { useSidebarSections } from "./sidebar-sections";

export const SIDEBAR_EMPTY_COPY = "No workbenches yet";

function SectionLabel({ children }: { readonly children: string }) {
  return <div className="shell-panel-section-label">{children}</div>;
}

function WorkbenchRow({
  tenant,
  active,
  onSelect,
}: {
  readonly tenant: HubTenant;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="shell-ch-row"
      aria-current={active ? "true" : undefined}
      data-active={active ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="shell-ch-avatar">
        <span className="shell-ch-initial" aria-hidden="true">
          <Hash />
        </span>
      </span>
      <span className="shell-ch-meta">
        <span className="shell-ch-name-row">
          <span className="shell-ch-name">{tenant.name}</span>
        </span>
      </span>
    </button>
  );
}

export function WorkbenchList({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const sections = useSidebarSections(selectedTenantId);

  if (sections.kind === "loading") {
    return (
      <div className="shell-activity-skeleton-rows" aria-hidden="true">
        <Skeleton className="shell-activity-skeleton-row" />
        <Skeleton className="shell-activity-skeleton-row" />
        <Skeleton className="shell-activity-skeleton-row" />
      </div>
    );
  }
  if (sections.kind === "error") {
    return (
      <EmptyState
        icon={<Hash />}
        title="Couldn't load your workbenches"
        description={sections.message}
      />
    );
  }

  const activeWorkbenchId = workbenchIdFromPath(path);
  const { workbenches } = sections;

  return (
    <div className="panel-stack" aria-label="Workbenches and workers">
      <div className="panel-stack-group">
        <SectionLabel>Workbenches</SectionLabel>
        {workbenches.length === 0 ? (
          <p className="shell-panel-list-empty">{SIDEBAR_EMPTY_COPY}</p>
        ) : null}
        {workbenches.map((tenant) => (
          <WorkbenchRow
            key={tenant.id}
            tenant={tenant}
            active={tenant.id === activeWorkbenchId}
            onSelect={() => onNavigate(workbenchPath(tenant.id))}
          />
        ))}
      </div>
      <WorkerGroup path={path} onNavigate={onNavigate} />
    </div>
  );
}

// No client-side in-flight-turn state is queryable here, so every worker
// renders idle.
function WorkerGroup({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const agents = useQuery({
    queryKey: tenantKeys.agents(selectedTenantId ?? "none"),
    enabled: selectedTenantId !== null,
    queryFn: () => listChatAgents(selectedTenantId as string),
  });
  const workers = agents.data ?? [];
  if (workers.length === 0) return null;
  return (
    <div className="panel-stack-group">
      <SectionLabel>Workers</SectionLabel>
      {workers.map((agent) => {
        const to = `/workers/${agent.id}`;
        const active = path === to;
        return (
          <button
            key={agent.id}
            type="button"
            className="shell-ch-row"
            aria-current={active ? "true" : undefined}
            data-active={active ? "true" : undefined}
            onClick={() => onNavigate(to)}
          >
            <WorkbenchAvatar kind="worker" name={agent.name} size="sm" status="idle" />
            <span className="shell-ch-meta">
              <span className="shell-ch-name-row">
                <span className="shell-ch-name">{agent.name}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
