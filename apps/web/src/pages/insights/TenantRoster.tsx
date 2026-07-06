import { Link } from "react-router";
import { Bot, ChevronRight, Workflow } from "lucide-react";
import type { RosterInstance, RosterRun } from "@workbench/client";
import { useTenantRoster } from "../../hooks/use-tenant-roster";
import { SectionLabel } from "./section-label";
import { actorHref } from "./ActorActivity";
import { humanizeToken } from "./activity-naming";
import {
  instanceStatusTone,
  runStatusTone,
  statusToneClass,
} from "./status-tone";

/** Deep link to a workflow run's execution trace. */
export function runHref(runId: string): string {
  return `/insights/trace/${encodeURIComponent(runId)}`;
}

function StatusChip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      data-testid="roster-status-chip"
      className={`inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.05em] ${tone}`}
    >
      {label}
    </span>
  );
}

function RosterCardLink({
  to,
  testid,
  icon,
  title,
  subtitle,
  rawId,
  chip,
}: {
  to: string;
  testid: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  rawId: string;
  chip: React.ReactNode;
}) {
  return (
    <li>
      <Link
        to={to}
        data-testid={testid}
        className="flex min-h-[40px] items-center gap-3 rounded-sm px-3 py-2.5 outline-none transition-[background-color,transform] hover:bg-row-hover focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-sm border border-border bg-surface-2 text-text-3">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-text">
              {title}
            </span>
            {chip}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-3">
            <span className="shrink-0">{subtitle}</span>
            <span aria-hidden>·</span>
            <span className="truncate font-mono text-[10px]">{rawId}</span>
          </span>
        </span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3" />
      </Link>
    </li>
  );
}

function RosterPanel({
  title,
  count,
  children,
}: {
  title: string;
  count: number | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between px-1">
        <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-3">
          {title}
        </h3>
        {count !== null && (
          <span className="font-mono text-[11px] tabular-nums text-text-3">
            {count.toLocaleString()}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-1.5" data-testid="tenant-roster-loading">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[52px] animate-pulse rounded-sm bg-surface-2"
        />
      ))}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <p className="rounded-sm bg-surface-2 px-3 py-6 text-center text-[12.5px] text-text-2">
      {text}
    </p>
  );
}

function InstanceList({ instances }: { instances: RosterInstance[] }) {
  if (instances.length === 0) {
    return <EmptyRow text="No agent instances in this workbench yet." />;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {instances.map((i) => (
        <RosterCardLink
          key={i.instanceId}
          to={actorHref(i.principalId)}
          testid="roster-instance"
          icon={<Bot className="h-3.5 w-3.5" />}
          title={i.name}
          subtitle={
            i.sessionCount === 1 ? "1 session" : `${i.sessionCount} sessions`
          }
          rawId={i.principalId}
          chip={
            <StatusChip
              label={i.status}
              tone={statusToneClass(instanceStatusTone(i.status))}
            />
          }
        />
      ))}
    </ul>
  );
}

function RunList({ runs }: { runs: RosterRun[] }) {
  if (runs.length === 0) {
    return <EmptyRow text="No workflow runs in this workbench yet." />;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {runs.map((r) => (
        <RosterCardLink
          key={r.runId}
          to={runHref(r.runId)}
          testid="roster-run"
          icon={<Workflow className="h-3.5 w-3.5" />}
          title={humanizeToken(r.kind)}
          subtitle={r.kind}
          rawId={r.runId}
          chip={
            <StatusChip
              label={r.status}
              tone={statusToneClass(runStatusTone(r.status))}
            />
          }
        />
      ))}
    </ul>
  );
}

/**
 * The dashboard-level, first-class clickable roster (CL-2798): every agent
 * instance and recent workflow run in the tenant, each row deep-linking to that
 * entity's own trace. This is the missing affordance — before, an agent
 * instance had no dashboard entry point at all and a run was only clickable deep
 * inside the activity feed. Own query lifecycle, gated on the tenant.
 */
export function TenantRoster({ tenantId }: { tenantId: string }) {
  const query = useTenantRoster(tenantId, { enabled: tenantId !== "" });
  const roster = query.data;

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Agents &amp; runs</SectionLabel>
      <p className="-mt-2 text-[11px] text-text-3">
        Open any agent or run to trace it.
      </p>

      {query.isError && (
        <div className="flex flex-col items-start gap-2 rounded border border-border bg-surface p-4">
          <span className="text-[13px] text-text-2">
            Couldn&rsquo;t load agents and runs. Please try again.
          </span>
          <button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
            className="flex min-h-[40px] items-center rounded-sm border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-[color,background-color,transform] hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Retry
          </button>
        </div>
      )}

      {!query.isError && (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <RosterPanel
            title="Agents"
            count={roster ? roster.instances.length : null}
          >
            {query.isLoading ? (
              <LoadingRows />
            ) : (
              <InstanceList instances={roster?.instances ?? []} />
            )}
          </RosterPanel>
          <RosterPanel
            title="Recent runs"
            count={roster ? roster.runs.length : null}
          >
            {query.isLoading ? (
              <LoadingRows />
            ) : (
              <RunList runs={roster?.runs ?? []} />
            )}
          </RosterPanel>
        </div>
      )}
    </div>
  );
}
