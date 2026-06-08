import { useCallback, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useWorkflowCatalog,
  useEnabledWorkflows,
  useInstallWorkflow,
} from '../../hooks/use-workflow';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export interface WorkflowCatalogModalProps {
  open: boolean;
  onClose: () => void;
  onInstalled: (kind: string) => void;
}

export function WorkflowCatalogModal({ open, onClose, onInstalled }: WorkflowCatalogModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const catalogQuery = useWorkflowCatalog();
  const enabledQuery = useEnabledWorkflows();
  const installMutation = useInstallWorkflow();

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

  const enabledKinds = new Set((enabledQuery.data ?? []).map((e) => e.kind));
  const catalog = catalogQuery.data ?? [];

  const handleInstall = async (kind: string) => {
    await installMutation.mutateAsync(kind);
    onInstalled(kind);
    onClose();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.55)] p-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          data-testid="workflow-catalog-modal-scrim"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Workflow catalog"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="text-[16px] font-bold text-text">Add workflow</div>
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

            <div className="flex flex-col gap-3 px-6 py-5">
              {catalogQuery.isLoading && (
                <p className="text-[13px] text-text-3">Loading catalog...</p>
              )}
              {catalogQuery.isError && (
                <p className="text-[13px] text-orange">Failed to load workflow catalog.</p>
              )}
              {catalog.map((entry) => {
                const isInstalled = enabledKinds.has(entry.kind);
                const isInstalling =
                  installMutation.isPending && installMutation.variables === entry.kind;
                return (
                  <div
                    key={entry.kind}
                    className="flex items-start justify-between gap-4 rounded-[10px] border border-border px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium text-text">{entry.name}</p>
                      {entry.description && (
                        <p className="mt-0.5 text-[12px] text-text-3">{entry.description}</p>
                      )}
                    </div>
                    {isInstalled ? (
                      <span className="flex flex-none items-center gap-1.5 rounded-full bg-[rgba(123,153,116,0.18)] px-2.5 py-1 text-[11px] font-medium text-green">
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="h-3 w-3"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                        Installed
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={isInstalling || installMutation.isPending}
                        onClick={() => void handleInstall(entry.kind)}
                        className="flex-none rounded-[9px] bg-orange px-3 py-1.5 text-[12px] font-medium text-white hover:bg-orange-deep disabled:opacity-50"
                      >
                        {isInstalling ? 'Installing...' : 'Install'}
                      </button>
                    )}
                  </div>
                );
              })}
              {!catalogQuery.isLoading && catalog.length === 0 && (
                <p className="text-[13px] text-text-3">No workflows available.</p>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
