// Artifact detail modal (CL-988). Stateless: open state and the artifact are
// owned by the caller; all actions are reported via callbacks. Provides a
// dimmed scrim, focus trap, and Escape-to-close. No data fetching.

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button, ConfirmButton } from "@workbench/ui";
import type { ArtifactWithSession } from "@workbench/shared";
import { isLinkedInPostArtifactKind } from "./artifact-kinds";
import { resolveArtifactClipboardText } from "./linkedin-clipboard";
import { ArtifactMeta } from "./ArtifactMeta";
import { ArtifactDetailShell } from "./ArtifactDetailShell";
import { visualForKind } from "./artifact-visuals";
import { labelForArtifactStatus } from "./artifact-preview-family";

export interface ArtifactModalAction {
  label: string;
  onClick: (artifact: ArtifactWithSession) => void;
  variant?: "primary" | "secondary" | "ghost";
}

export interface ArtifactModalProps {
  /** When false, nothing is rendered. */
  open: boolean;
  /** The artifact to display. Required when open. */
  artifact: ArtifactWithSession | null;
  /** Invoked on Escape, scrim click, or the close control. */
  onClose: () => void;
  /** Footer action buttons. */
  actions?: ArtifactModalAction[];
  /** Optional custom body; defaults to the artifact content (plain text). */
  children?: ReactNode;
  /** Human-readable label for the artifact kind, e.g. "LinkedIn Post". */
  kindLabel?: string;
  /** When provided, renders an "Open in Myra" button that hands the artifact to the caller. */
  onOpenInMyra?: (artifact: ArtifactWithSession) => void;
  /** When provided, renders a "Use in Workflow" button for eligible artifacts. */
  onUseInWorkflow?: (artifact: ArtifactWithSession) => void;
  /**
   * When provided, renders an "Archive" button that soft-hides the artifact.
   * The caller is responsible for the owner/admin permission check — the button
   * is only shown when this callback is passed.
   */
  onArchive?: (artifact: ArtifactWithSession) => void;
  /**
   * Decides whether the current artifact may be used in a workflow. Eligibility
   * is a workflow product rule, so the caller injects it; absent a predicate the
   * action is offered for any artifact.
   */
  canUseInWorkflow?: (artifact: ArtifactWithSession) => boolean;
  /** Navigates to the originating session/run when the session name is clicked. */
  onOpenSession?: (sessionId: string) => void;
  /** Navigates to the parent artifact when "Derived from" is clicked. */
  onOpenParent?: (parentId: string) => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function ArtifactModal({
  open,
  artifact,
  onClose,
  actions = [],
  children,
  kindLabel,
  onOpenInMyra,
  onUseInWorkflow,
  onArchive,
  canUseInWorkflow,
  onOpenSession,
  onOpenParent,
}: ArtifactModalProps) {
  const showUseInWorkflow = Boolean(
    onUseInWorkflow &&
      artifact &&
      (canUseInWorkflow ? canUseInWorkflow(artifact) : true),
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [formatForLinkedIn, setFormatForLinkedIn] = useState(true);
  const showLinkedInFormatGate = Boolean(
    artifact && isLinkedInPostArtifactKind(artifact.kind),
  );

  useEffect(() => {
    if (!open) return;
    setFormatForLinkedIn(true);
  }, [open, artifact?.id, artifact?.kind]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  // Move focus into the panel when it opens.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    (items[0] ?? panelRef.current).focus();
  }, [open]);

  return (
    <AnimatePresence>
      {open && artifact && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.55)] p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          data-testid="artifact-modal-scrim"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={artifact.title}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18 }}
            className="flex h-[min(90vh,900px)] w-[min(96vw,72rem)] flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            <ArtifactDetailShell
              compactRail
              accentClass={visualForKind(artifact.kind).fill}
              header={
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[16px] font-bold text-text">
                      {artifact.title}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-text-3">
                      v{artifact.version} ·{" "}
                      {labelForArtifactStatus(artifact.status)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="grid h-8 w-8 flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="h-4 w-4"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              }
              rail={
                <div className="flex flex-col gap-3 text-[13px] text-text-2">
                  <ArtifactMeta
                    kindLabel={kindLabel}
                    createdAt={artifact.createdAt}
                    sessionId={artifact.sessionId}
                    sessionName={artifact.sessionName}
                    sessionStatus={artifact.sessionStatus}
                    parentId={artifact.parentId}
                    onOpenSession={onOpenSession}
                    onOpenParent={onOpenParent}
                  />
                  {showLinkedInFormatGate && (
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-3">
                      <input
                        type="checkbox"
                        checked={formatForLinkedIn}
                        onChange={(e) => setFormatForLinkedIn(e.target.checked)}
                        className="accent-charcoal"
                      />
                      Format for LinkedIn paste
                    </label>
                  )}
                  <button
                    type="button"
                    aria-label={
                      copyFailed
                        ? "Copy failed"
                        : copied
                          ? "Copied"
                          : "Copy content"
                    }
                    onClick={() => {
                      const text = resolveArtifactClipboardText(
                        artifact.content,
                        artifact.kind,
                        formatForLinkedIn,
                      );
                      setCopied(false);
                      setCopyFailed(false);
                      void navigator.clipboard
                        .writeText(text)
                        .then(() => {
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        })
                        .catch(() => {
                          setCopyFailed(true);
                          setTimeout(() => setCopyFailed(false), 1500);
                        });
                    }}
                    className="flex w-full items-center justify-center gap-1.5 rounded-[7px] border border-border bg-surface px-2 py-1.5 text-[11px] text-text-3 transition-colors hover:text-text"
                  >
                    {copyFailed
                      ? "Copy failed"
                      : copied
                        ? "Copied"
                        : "Copy content"}
                  </button>
                  <div className="flex flex-wrap gap-2">
                    {onArchive && (
                      <ConfirmButton
                        variant="ghost"
                        size="sm"
                        confirmLabel="Confirm archive"
                        onConfirm={() => onArchive(artifact)}
                      >
                        Archive
                      </ConfirmButton>
                    )}
                    {onOpenInMyra && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onOpenInMyra(artifact)}
                      >
                        Open in Myra
                      </Button>
                    )}
                    {showUseInWorkflow && onUseInWorkflow && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onUseInWorkflow(artifact)}
                      >
                        Use in Workflow
                      </Button>
                    )}
                    {actions.map((action) => (
                      <Button
                        key={action.label}
                        variant={action.variant ?? "secondary"}
                        size="sm"
                        onClick={() => action.onClick(artifact)}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                </div>
              }
            >
              <div className="relative text-[14px] leading-relaxed text-text-2">
                {children ?? (
                  <p className="whitespace-pre-wrap">{artifact.content}</p>
                )}
              </div>
            </ArtifactDetailShell>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
