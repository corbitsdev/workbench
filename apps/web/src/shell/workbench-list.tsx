// One section and nothing else: Workbenches. Agent membership is a
// workbench concept.

import { EmptyState, Skeleton } from "@corbits/react-ui";
import { WorkbenchAvatar } from "@/chat/avatar";
import { Hash } from "@/lib/icons";

import { useBench } from "../bench-context";
import { useBenchWorkerStatus } from "../worker-status";
import { useBenchWorkers, type BenchWorker } from "../worker-benches";
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

function WorkerRow({
  worker,
  active,
  onSelect,
}: {
  readonly worker: BenchWorker;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { agent, bench } = worker;
  const status = useBenchWorkerStatus([bench], (p) => p.id === agent.id);
  return (
    <button
      type="button"
      className="shell-ch-row"
      aria-current={active ? "true" : undefined}
      data-active={active ? "true" : undefined}
      onClick={onSelect}
    >
      <WorkbenchAvatar kind="worker" name={agent.name} size="sm" status={status.tone} />
      <span className="shell-ch-meta">
        <span className="shell-ch-name-row">
          <span className="shell-ch-name">{agent.name}</span>
        </span>
      </span>
    </button>
  );
}

function WorkerGroup({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (to: string) => void;
}) {
  const { workers } = useBenchWorkers();
  return (
    <div className="panel-stack-group">
      <SectionLabel>Workers</SectionLabel>
      {workers.length === 0 ? <p className="shell-panel-list-empty">No workers yet</p> : null}
      {workers.map((worker) => {
        const to = `/workers/${worker.agent.id}`;
        return (
          <WorkerRow
            key={worker.agent.id}
            worker={worker}
            active={path === to}
            onSelect={() => onNavigate(to)}
          />
        );
      })}
    </div>
  );
}
