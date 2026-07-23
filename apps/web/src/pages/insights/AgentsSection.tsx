import { useState } from "react";
import { Link } from "react-router";
import type { RosterInstance } from "@workbench/client";
import { Badge } from "@workbench/ui";

import type { ActivityOverview } from "../../lib/hub-api";
import { useTenantRoster } from "../../hooks/use-tenant-roster";
import { actorHref } from "./ActorActivity";
import { sumInferenceTokenClasses } from "./metrics";
import { formatNumber } from "./stats";
import { SectionLabel } from "./section-label";
import { instanceStatusTone, statusToneClass } from "./status-tone";

const ROSTER_PAGE_SIZE = 12;

// member_agent_instance.template_key values that identify the two Myra
// surfaces this roster distinguishes. Runtime writes use the canonical keys
// ("myra" / "myra-triage"), but variant definitions use prefixed keys
// ("myra-chat-<model>" / "myra-triage-<model>") that tenant provisioning can
// also mint — so classify by prefix, triage first (its keys also start with
// "myra"). Mirrors myraSurfaceForTemplateKey in packages/myra; kept local
// rather than adding a web dependency on that package.
function myraSurface(templateKey: string): "chat" | "triage" | null {
  if (templateKey === "myra-triage" || templateKey.startsWith("myra-triage-")) {
    return "triage";
  }
  if (templateKey === "myra" || templateKey.startsWith("myra-chat-")) {
    return "chat";
  }
  return null;
}

const TRIAGE_LABEL_PREFIX = /^Triage:\s*/;

type InstanceMetrics = {
  turnCount: number;
  toolCallCount: number;
  tokens: number;
};

type InstanceDisplay = {
  name: string;
  badgeLabel: "Chat" | "Inbox routine" | null;
};

/** Shown when an instance has no usable title/subject yet. */
function fallbackTitle(instance: RosterInstance): string {
  return instance.address || instance.instanceId.slice(0, 8);
}

/**
 * Names one Myra instance for the roster row (CL-3770): a chat thread reads
 * "Myra — <thread title>", a triage/routine instance reads
 * "Myra — <mail subject>" (the hub stores that as "Triage: <subject>" in the
 * same label column — CL-2737's mailbox-triage.ts), and any other agent kind
 * keeps its existing definition name with no badge.
 */
export function displayForInstance(instance: RosterInstance): InstanceDisplay {
  const surface = myraSurface(instance.templateKey);
  if (surface === "chat") {
    const title = instance.label?.trim() || fallbackTitle(instance);
    return { name: `Myra — ${title}`, badgeLabel: "Chat" };
  }
  if (surface === "triage") {
    const subject = instance.label?.replace(TRIAGE_LABEL_PREFIX, "").trim();
    const title = subject || fallbackTitle(instance);
    return { name: `Myra — ${title}`, badgeLabel: "Inbox routine" };
  }
  return { name: instance.name, badgeLabel: null };
}

/** Most-recent-activity-first, so the roster surfaces what's live now. */
function sortByRecentActivity(instances: RosterInstance[]): RosterInstance[] {
  return [...instances].sort(
    (a, b) =>
      new Date(b.lastActivityAt).getTime() -
      new Date(a.lastActivityAt).getTime(),
  );
}

function InstanceRow({
  instance,
  metrics,
}: {
  instance: RosterInstance;
  metrics: InstanceMetrics | undefined;
}) {
  const { name, badgeLabel } = displayForInstance(instance);
  return (
    <Link
      to={actorHref(instance.principalId)}
      className="flex items-center gap-3 rounded-[12px] border border-border bg-surface px-4 py-3 outline-none transition-[background-color] hover:bg-row-hover focus-visible:ring-1 focus-visible:ring-accent"
      data-testid="agent-instance-row"
    >
      <span
        className={`inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.05em] ${statusToneClass(instanceStatusTone(instance.status))}`}
      >
        {instance.status}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">
        {name}
      </span>
      {badgeLabel && <Badge tone="neutral">{badgeLabel}</Badge>}
      <span className="shrink-0 text-[11px] text-text-3">
        {instance.sessionCount === 1
          ? "1 session"
          : `${instance.sessionCount} sessions`}
      </span>
      <span className="font-mono tabular-nums text-[11px] text-text-3">
        {metrics ? `${formatNumber(metrics.turnCount)} chats` : "no usage"}
      </span>
      <span className="font-mono tabular-nums text-[11px] text-text-3">
        {metrics ? `${formatNumber(metrics.toolCallCount)} tools` : ""}
      </span>
      <span className="font-mono tabular-nums text-[11px] text-text-3">
        {metrics ? `${formatNumber(metrics.tokens)} tok` : ""}
      </span>
    </Link>
  );
}

export function AgentsSection({
  tenantId,
  data,
}: {
  tenantId: string;
  data: ActivityOverview;
}) {
  const [page, setPage] = useState(0);
  const query = useTenantRoster(tenantId, { enabled: tenantId !== "" });
  const roster = query.data;

  const metricsByInstance = new Map<string, InstanceMetrics>(
    data.inference.byInstance.map((row) => [
      row.instanceId,
      {
        turnCount: row.turnCount,
        toolCallCount: row.toolCallCount,
        tokens: sumInferenceTokenClasses(row),
      },
    ]),
  );

  const instances = sortByRecentActivity(roster?.instances ?? []);
  const pageCount = Math.max(1, Math.ceil(instances.length / ROSTER_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = instances.slice(
    currentPage * ROSTER_PAGE_SIZE,
    currentPage * ROSTER_PAGE_SIZE + ROSTER_PAGE_SIZE,
  );

  return (
    <div className="flex flex-col gap-4">
      <SectionLabel>Agents</SectionLabel>
      <p className="-mt-2 text-[11px] text-text-3">
        One row per agent instance, most recently active first.
      </p>

      {query.isError && (
        <div className="flex flex-col items-start gap-2 rounded border border-border bg-surface p-4">
          <span className="text-[13px] text-text-2">
            Couldn&rsquo;t load agents. Please try again.
          </span>
          <button
            type="button"
            onClick={() => {
              void query.refetch();
            }}
            className="flex min-h-[40px] items-center rounded-sm border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-[color,background-color] hover:bg-row-hover hover:text-text focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97]"
          >
            Retry
          </button>
        </div>
      )}

      {!query.isError && query.isLoading && (
        <div className="flex flex-col gap-2" data-testid="agents-loading">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[52px] animate-pulse rounded-[12px] bg-surface-2"
            />
          ))}
        </div>
      )}

      {!query.isError && !query.isLoading && instances.length === 0 && (
        <p className="rounded-[12px] border border-border bg-surface p-4 text-center text-[12.5px] text-text-2">
          No agent instances in this workbench yet.
        </p>
      )}

      {!query.isError && !query.isLoading && instances.length > 0 && (
        <div className="flex flex-col gap-2">
          {visible.map((instance) => (
            <InstanceRow
              key={instance.instanceId}
              instance={instance}
              metrics={metricsByInstance.get(instance.instanceId)}
            />
          ))}
        </div>
      )}

      {!query.isError && !query.isLoading && pageCount > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-text-3">
            Page {currentPage + 1} of {pageCount} &middot;{" "}
            {formatNumber(instances.length)} instances
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(Math.max(0, currentPage - 1))}
              className="rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-accent"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
              className="rounded-[8px] border border-border px-2.5 py-1.5 text-[12px] font-medium text-text-2 outline-none transition-colors hover:bg-row-hover disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-1 focus-visible:ring-accent"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
