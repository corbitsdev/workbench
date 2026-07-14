// Shared metadata strip for an artifact: kind/date, session provenance, and
// version lineage. Rendered by both ArtifactModal and the web
// ArtifactDetailPage so the two surfaces never show different fields for the
// same artifact (CL-3512). Stateless and navigation-agnostic: the host
// supplies the actual navigation via onOpenSession/onOpenParent callbacks.

import { Fragment, type ReactNode } from "react";
import { Badge, type BadgeTone } from "@workbench/ui";
import type { SessionStatus } from "@workbench/shared";

export interface ArtifactMetaProps {
  kindLabel?: string | undefined;
  version?: number | undefined;
  statusLabel?: string | undefined;
  createdAt: string | null;
  sessionId: string | null;
  sessionName: string | null;
  sessionStatus: SessionStatus | null;
  parentId: string | null;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onOpenParent?: ((parentId: string) => void) | undefined;
  className?: string | undefined;
}

const SESSION_STATUS_TONE: Record<SessionStatus, BadgeTone> = {
  pending: "neutral",
  analyzing: "neutral",
  ready: "identity",
  generating: "identity",
  reviewing: "accent",
  done: "positive",
  failed: "danger",
};

export function formatArtifactDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function ArtifactMeta({
  kindLabel,
  version,
  statusLabel,
  createdAt,
  sessionId,
  sessionName,
  sessionStatus,
  parentId,
  onOpenSession,
  onOpenParent,
  className,
}: ArtifactMetaProps) {
  const canOpenSession = sessionId !== null && onOpenSession !== undefined;
  const canOpenParent = parentId !== null && onOpenParent !== undefined;

  const summaryParts: ReactNode[] = [];
  if (kindLabel) summaryParts.push(<span>{kindLabel}</span>);
  if (version !== undefined) summaryParts.push(<span>{`v${version}`}</span>);
  if (statusLabel) summaryParts.push(<span>{statusLabel}</span>);
  if (createdAt) summaryParts.push(<span>{formatArtifactDate(createdAt)}</span>);

  return (
    <div className={className}>
      {summaryParts.length > 0 && (
        <div className="text-[11px] text-text-3">
          {summaryParts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && <span> · </span>}
              {part}
            </Fragment>
          ))}
        </div>
      )}
      {(sessionName !== null || sessionStatus !== null) && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-text-3">
          {sessionName !== null &&
            (canOpenSession ? (
              <button
                type="button"
                onClick={() => onOpenSession(sessionId)}
                className="underline decoration-dotted underline-offset-2 hover:text-text"
              >
                {sessionName}
              </button>
            ) : (
              <span>{sessionName}</span>
            ))}
          {sessionStatus !== null && (
            <Badge tone={SESSION_STATUS_TONE[sessionStatus]}>
              {sessionStatus}
            </Badge>
          )}
        </div>
      )}
      {parentId !== null && (
        <div className="mt-1 text-[11px] text-text-3">
          {canOpenParent ? (
            <button
              type="button"
              onClick={() => onOpenParent(parentId)}
              className="underline decoration-dotted underline-offset-2 hover:text-text"
            >
              Derived from a previous version
            </button>
          ) : (
            <span>Derived from a previous version</span>
          )}
        </div>
      )}
    </div>
  );
}
