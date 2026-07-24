import type { ReactNode } from "react";
import { cn } from "./cn";
import {
  InspectorHeader,
  InspectorKv,
  InspectorPanelTitle,
  InspectorShell,
} from "./InspectorShell";
import { ScopePill, StatusChip } from "./primitives";
import { StepList } from "./StepList";
import type {
  LiveRunPhase,
  StepListItem,
  WorkflowScope,
  WorkflowStatusTone,
} from "./types";

export function livePhaseToTone(phase: LiveRunPhase): WorkflowStatusTone {
  switch (phase) {
    case "running":
      return "running";
    case "awaiting":
      return "awaiting";
    case "completed":
      return "done";
    case "failed":
    case "cancelled":
      return "fail";
  }
}

export function livePhaseLabel(phase: LiveRunPhase): string {
  switch (phase) {
    case "running":
      return "Running";
    case "awaiting":
      return "Needs you";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function LiveBanner({
  awaiting,
  message,
  elapsed,
  className,
}: {
  awaiting?: boolean;
  message?: string;
  elapsed?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border px-3 py-2 text-[12.5px]",
        awaiting
          ? "border-accent/35 bg-accent/10 text-accent-deep"
          : "border-blue/25 bg-blue/10 text-blue-deep",
        className,
      )}
    >
      <span className="font-semibold">
        {message ??
          (awaiting
            ? "Paused for your input"
            : "Running · right-side live status")}
      </span>
      {elapsed ? (
        <span className="font-mono text-[11.5px] opacity-90">{elapsed}</span>
      ) : null}
    </div>
  );
}

export function LiveRunInspector({
  phase,
  scope,
  title,
  description,
  categoryPill,
  elapsed,
  started,
  origin,
  kindSlug,
  runId,
  steps,
  gate,
  onStop,
  onOpenChat,
  stopLabel = "Stop",
  openChatLabel = "Open in chat",
  className,
  empty,
}: {
  phase: LiveRunPhase;
  scope?: WorkflowScope;
  title: string;
  description?: string;
  categoryPill?: ReactNode;
  elapsed?: string;
  started?: string;
  origin?: string;
  kindSlug?: string;
  runId?: string;
  steps?: readonly StepListItem[];
  /** Gate shell + interactive payload from the host. */
  gate?: ReactNode;
  onStop?: () => void;
  onOpenChat?: () => void;
  stopLabel?: string;
  openChatLabel?: string;
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

  const tone = livePhaseToTone(phase);
  const awaiting = phase === "awaiting";
  const elapsedLine = [elapsed, started ? `started ${started}` : null]
    .filter(Boolean)
    .join(" · ");

  const metaRows = [
    origin !== undefined ? { label: "Origin", value: origin } : null,
    kindSlug !== undefined
      ? { label: "Kind", value: kindSlug, mono: true as const }
      : null,
    runId !== undefined
      ? { label: "Run id", value: runId, mono: true as const }
      : null,
  ].filter((r): r is { label: string; value: string; mono?: true } => r !== null);

  return (
    <InspectorShell
      {...(className !== undefined ? { className } : {})}
      header={
        <InspectorHeader
          eyebrow={
            <>
              <StatusChip tone={tone} label={livePhaseLabel(phase)} />
              {scope ? (
                <ScopePill
                  scope={scope}
                  label={scope === "tenant" ? "Everyone" : "Just me"}
                />
              ) : null}
              {categoryPill}
            </>
          }
          title={title}
          {...(description !== undefined ? { description } : {})}
          actions={
            <>
              {!awaiting && onStop ? (
                <button
                  type="button"
                  onClick={onStop}
                  className="rounded-[7px] border border-red/35 bg-red/10 px-2.5 py-1 text-[12px] font-semibold text-red"
                >
                  {stopLabel}
                </button>
              ) : null}
              {onOpenChat ? (
                <button
                  type="button"
                  onClick={onOpenChat}
                  className="rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[12px] font-semibold text-text-2 hover:border-border-strong hover:text-text"
                >
                  {openChatLabel}
                </button>
              ) : null}
            </>
          }
        />
      }
    >
      <LiveBanner
        awaiting={awaiting}
        {...(elapsedLine ? { elapsed: elapsedLine } : {})}
      />
      {gate}
      {steps ? <StepList steps={steps} /> : null}
      {metaRows.length > 0 ? (
        <>
          <InspectorPanelTitle>Run</InspectorPanelTitle>
          <InspectorKv rows={metaRows} />
        </>
      ) : null}
    </InspectorShell>
  );
}
