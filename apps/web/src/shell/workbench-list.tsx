// One section and nothing else: Workbenches. Agent membership is a
// workbench concept.

import { EmptyState, Input, Skeleton } from "@corbits/react-ui";
import { Hash, MagnifyingGlass } from "@/lib/icons";
import { useState } from "react";

import { useBench } from "../bench-context";
import { workbenchIdFromPath, workbenchPath } from "../workbench-path";
import type { HubTenant } from "../needs-converge";
import { useSidebarSections } from "./sidebar-sections";

export const SIDEBAR_EMPTY_COPY = "No workbenches yet";

function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

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
  const [query, setQuery] = useState("");

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

  const needle = query.trim().toLowerCase();
  const workbenches = sections.workbenches.filter(
    (tenant) => needle === "" || matches(tenant.name, needle),
  );
  const activeWorkbenchId = workbenchIdFromPath(path);

  return (
    <div className="panel-stack" aria-label="Workbenches">
      <label className="shell-panel-search">
        <MagnifyingGlass aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search…"
          aria-label="Search workbenches"
        />
      </label>

      {workbenches.length === 0 ? (
        <p className="shell-panel-list-empty">{SIDEBAR_EMPTY_COPY}</p>
      ) : null}

      {workbenches.length === 0 ? null : (
        <div className="panel-stack-group">
          <SectionLabel>Workbenches</SectionLabel>
          {workbenches.map((tenant) => (
            <WorkbenchRow
              key={tenant.id}
              tenant={tenant}
              active={tenant.id === activeWorkbenchId}
              onSelect={() => onNavigate(workbenchPath(tenant.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
