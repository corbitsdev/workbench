// Artifact detail modal (CL-988). Stateless: open state and the artifact are
// owned by the caller; all actions are reported via callbacks. Provides a
// dimmed scrim, focus trap, and Escape-to-close. No data fetching.

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button } from '@workbench/ui';
import type { ArtifactWithSession } from '@workbench/shared';

export interface ArtifactModalAction {
  label: string;
  onClick: (artifact: ArtifactWithSession) => void;
  variant?: 'primary' | 'secondary' | 'ghost';
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
  /** When provided, renders an "Open in Myra" anchor in the footer. */
  myraHref?: string;
  /** When provided, renders a "Use in Workflow" button for eligible artifacts. */
  onUseInWorkflow?: (artifact: ArtifactWithSession) => void;
  /**
   * Decides whether the current artifact may be used in a workflow. Eligibility
   * is a workflow product rule, so the caller injects it; absent a predicate the
   * action is offered for any artifact.
   */
  canUseInWorkflow?: (artifact: ArtifactWithSession) => boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function ArtifactModal({
  open,
  artifact,
  onClose,
  actions = [],
  children,
  kindLabel,
  myraHref,
  onUseInWorkflow,
  canUseInWorkflow,
}: ArtifactModalProps) {
  const showUseInWorkflow = Boolean(
    onUseInWorkflow && artifact && (canUseInWorkflow ? canUseInWorkflow(artifact) : true)
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
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
    [onClose]
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
          className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.55)] p-4 backdrop-blur-[2px]"
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
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            <div className="flex items-start gap-3 border-b border-border px-6 py-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[16px] font-bold text-text">{artifact.title}</div>
                <div className="mt-0.5 font-mono text-[11px] text-text-3">
                  {artifact.sessionName ?? 'Untitled job'} · v{artifact.version}
                </div>
                {(kindLabel ?? artifact.createdAt) && (
                  <div className="mt-1 text-[11px] text-text-3">
                    {kindLabel && <span>{kindLabel}</span>}
                    {kindLabel && artifact.createdAt && <span> · </span>}
                    {artifact.createdAt && <span>{formatDate(artifact.createdAt)}</span>}
                  </div>
                )}
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

            <div className="relative flex-1 overflow-y-auto px-6 py-5 text-[14px] leading-relaxed text-text-2">
              <button
                type="button"
                aria-label={copied ? 'Copied' : 'Copy content'}
                onClick={() => {
                  void navigator.clipboard.writeText(artifact.content).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="absolute right-4 top-4 flex items-center gap-1.5 rounded-[7px] border border-border bg-surface px-2 py-1 text-[11px] text-text-3 transition-colors hover:text-text active:scale-[0.97]"
              >
                {copied ? (
                  'Copied'
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="h-3.5 w-3.5"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
                )}
              </button>
              {children ?? <p className="whitespace-pre-wrap">{artifact.content}</p>}
            </div>

            {(actions.length > 0 || myraHref || showUseInWorkflow) && (
              <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
                {myraHref && (
                  <a
                    href={myraHref}
                    className="flex items-center gap-[7px] rounded-[9px] border border-border px-[13px] py-[7px] text-[12.5px] font-semibold text-text-2 transition-colors hover:border-border-strong hover:bg-[var(--row-hover)]"
                  >
                    Open in Myra
                  </a>
                )}
                {showUseInWorkflow && artifact && onUseInWorkflow && (
                  <Button variant="secondary" size="sm" onClick={() => onUseInWorkflow(artifact)}>
                    Use in Workflow
                  </Button>
                )}
                {actions.map((action) => (
                  <Button
                    key={action.label}
                    variant={action.variant ?? 'secondary'}
                    size="sm"
                    onClick={() => action.onClick(artifact)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
