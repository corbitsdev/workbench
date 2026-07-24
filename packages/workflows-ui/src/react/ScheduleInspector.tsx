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

export function ScheduleInspectorEdit({
  title,
  name,
  cadence,
  scope,
  onNameChange,
  onCadenceChange,
  onSave,
  onCancel,
  onRemove,
  saving,
  className,
  nameLabel = "Name",
  cadenceLabel = "Cadence",
  saveLabel = "Save",
  cancelLabel = "Cancel",
  removeLabel = "Remove schedule",
  banner = "Editing schedule — scope cannot change here.",
}: {
  title: string;
  name: string;
  cadence: string;
  scope: WorkflowScope;
  onNameChange?: (value: string) => void;
  onCadenceChange?: (value: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onRemove?: () => void;
  saving?: boolean;
  className?: string;
  nameLabel?: string;
  cadenceLabel?: string;
  saveLabel?: string;
  cancelLabel?: string;
  removeLabel?: string;
  banner?: string;
}) {
  return (
    <InspectorShell
      {...(className !== undefined ? { className } : {})}
      header={
        <InspectorHeader
          title={title}
          actions={
            <>
              {onSave ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={onSave}
                  className="rounded-[7px] bg-accent px-2.5 py-1 text-[12px] font-bold text-white shadow-sm hover:bg-accent-deep disabled:opacity-50"
                >
                  {saveLabel}
                </button>
              ) : null}
              {onCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[12px] font-semibold text-text-2"
                >
                  {cancelLabel}
                </button>
              ) : null}
            </>
          }
        />
      }
    >
      {banner ? (
        <div className="mb-3 rounded-[10px] border border-accent/30 bg-accent/10 px-3 py-2 text-[12px] font-semibold text-accent-deep">
          {banner}
        </div>
      ) : null}
      <label className="mb-3 flex flex-col gap-1">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-text-3">
          {cadenceLabel}
        </span>
        <input
          value={cadence}
          onChange={(e) => onCadenceChange?.(e.target.value)}
          className="rounded-[9px] border border-border bg-surface px-3 py-2 font-mono text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </label>
      <label className="mb-3 flex flex-col gap-1">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-text-3">
          {nameLabel}
        </span>
        <input
          value={name}
          onChange={(e) => onNameChange?.(e.target.value)}
          className="rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </label>
      <label className="mb-4 flex flex-col gap-1 opacity-60">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.05em] text-text-3">
          Scope
        </span>
        <input
          disabled
          value={scope === "tenant" ? "Everyone" : "Just me"}
          className="cursor-not-allowed rounded-[9px] border border-border bg-surface-2 px-3 py-2 text-[13px] text-text-3"
        />
      </label>
      {onRemove ? (
        <div className="mt-6 border-t border-border pt-4">
          <div className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.05em] text-red">
            Danger zone
          </div>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-[7px] border border-red/35 bg-red/10 px-2.5 py-1.5 text-[12px] font-semibold text-red"
          >
            {removeLabel}
          </button>
        </div>
      ) : null}
    </InspectorShell>
  );
}
