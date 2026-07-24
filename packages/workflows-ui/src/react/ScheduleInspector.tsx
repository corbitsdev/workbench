import type { ReactNode } from "react";
import { cn } from "./cn";
import {
  InspectorHeader,
  InspectorKv,
  InspectorPanelTitle,
  InspectorShell,
} from "./InspectorShell";
import { ScopePill, StatusChip } from "./primitives";
import type { WorkflowScope } from "./types";

export function ReadBlock({
  label,
  value,
  sub,
  mono,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[10px] border border-border bg-surface-2/40 px-3 py-2.5",
        className,
      )}
    >
      <div className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-text-3">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-[13.5px] font-semibold text-text",
          mono && "font-mono text-[12.5px]",
        )}
      >
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 text-[11.5px] text-text-3">{sub}</div>
      ) : null}
    </div>
  );
}

export function ScheduleInspectorView({
  enabled,
  scope,
  title,
  description,
  categoryPill,
  cadence,
  next,
  last,
  name,
  kindSlug,
  scheduleId,
  recentRuns,
  onEdit,
  onRunNow,
  onTogglePause,
  editLabel = "Edit",
  runNowLabel = "Run now",
  className,
  empty,
}: {
  enabled: boolean;
  scope: WorkflowScope;
  title: string;
  description?: string;
  categoryPill?: ReactNode;
  cadence: string;
  next?: string;
  last?: string;
  name?: string;
  kindSlug?: string;
  scheduleId?: string;
  recentRuns?: ReactNode;
  onEdit?: () => void;
  onRunNow?: () => void;
  onTogglePause?: () => void;
  editLabel?: string;
  runNowLabel?: string;
  className?: string;
  empty?: ReactNode;
}) {
  if (empty !== undefined && empty !== null) {
    return (
      <InspectorShell
        empty={empty}
        {...(className !== undefined ? { className } : {})}
      />
    );
  }

  return (
    <InspectorShell
      {...(className !== undefined ? { className } : {})}
      header={
        <InspectorHeader
          eyebrow={
            <>
              <StatusChip
                tone={enabled ? "running" : "paused"}
                label={enabled ? "Active" : "Paused"}
                pulse={enabled}
              />
              <ScopePill
                scope={scope}
                label={scope === "tenant" ? "Everyone" : "Just me"}
              />
              {categoryPill}
            </>
          }
          title={title}
          {...(description !== undefined ? { description } : {})}
          actions={
            <>
              {onEdit ? (
                <button
                  type="button"
                  onClick={onEdit}
                  className="rounded-[7px] bg-accent px-2.5 py-1 text-[12px] font-bold text-white shadow-sm hover:bg-accent-deep"
                >
                  {editLabel}
                </button>
              ) : null}
              {onRunNow ? (
                <button
                  type="button"
                  onClick={onRunNow}
                  className="rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[12px] font-semibold text-text-2 hover:border-border-strong hover:text-text"
                >
                  {runNowLabel}
                </button>
              ) : null}
              {onTogglePause ? (
                <button
                  type="button"
                  onClick={onTogglePause}
                  className="rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[12px] font-semibold text-text-2 hover:border-border-strong hover:text-text"
                >
                  {enabled ? "Pause" : "Resume"}
                </button>
              ) : null}
            </>
          }
        />
      }
    >
      <InspectorPanelTitle>Overview</InspectorPanelTitle>
      <div className="flex flex-col gap-2">
        <ReadBlock
          label="Cadence"
          value={cadence}
          mono
          {...(next || last
            ? {
                sub: [
                  next ? `Next ${next}` : null,
                  last ? `last ${last}` : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }
            : {})}
        />
      </div>
      {/* Name and scope are read-only here (edit the name under Edit; scope
          is fixed at create) — plain metadata rows, not editable-looking
          field cards. */}
      <InspectorPanelTitle>Details</InspectorPanelTitle>
      <InspectorKv
        rows={[
          {
            label: "Name",
            value: name?.trim() ? name : "Default (workflow name)",
          },
          {
            label: "Scope",
            value: scope === "tenant" ? "Everyone" : "Just me",
          },
        ]}
      />
      {recentRuns}
      {(kindSlug || scheduleId || last) && (
        <>
          <InspectorPanelTitle>Meta</InspectorPanelTitle>
          <InspectorKv
            rows={[
              ...(kindSlug
                ? [{ label: "Kind", value: kindSlug, mono: true as const }]
                : []),
              ...(scheduleId
                ? [{ label: "Id", value: scheduleId, mono: true as const }]
                : []),
              ...(last ? [{ label: "Last fire", value: last }] : []),
            ]}
          />
        </>
      )}
    </InspectorShell>
  );
}
