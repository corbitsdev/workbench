import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  useStartWorkflow,
  useWorkflowDeployments,
} from "../../hooks/use-workflow";
import { dedupeDeployedWorkflows } from "../../lib/deployed-workflows";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export interface UnifiedCatalogModalProps {
  open: boolean;
  tenantId: string | null;
  onClose: () => void;
  onWorkflowStarted: (deploymentId: string) => void;
}

// Dumb launcher. Lists deployed workflow kinds; clicking a workflow card starts
// a run immediately and hands the new deploymentId back. There is no
// pre-workflow screen — the run's own Panel renders the experience.
export function UnifiedCatalogModal({
  open,
  tenantId,
  onClose,
  onWorkflowStarted,
}: UnifiedCatalogModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: workflowDeployments = [], isPending: workflowsPending } =
    useWorkflowDeployments(tenantId);
  const startWorkflow = useStartWorkflow(tenantId);

  const deployedWorkflows = useMemo(
    () => dedupeDeployedWorkflows(workflowDeployments),
    [workflowDeployments],
  );

  const handleClose = useCallback(() => {
    setError(null);
    setSearch("");
    onClose();
  }, [onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handleClose();
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
    [handleClose],
  );

  const startingKind = startWorkflow.isPending
    ? (startWorkflow.variables?.kind ?? null)
    : null;

  // Focus the first interactive element whenever the modal opens. This is a DOM
  // mutation — useLayoutEffect runs synchronously after the DOM updates, before
  // the browser paints, which prevents flicker.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    (items[0] ?? panelRef.current).focus();
  }, [open]);

  const query = search.toLowerCase();

  const filteredWorkflows = deployedWorkflows.filter(
    (w) =>
      w.label.toLowerCase().includes(query) ||
      w.kind.toLowerCase().includes(query),
  );

  const handleStartWorkflow = (kind: string) => {
    if (startWorkflow.isPending) return;
    setError(null);
    startWorkflow
      .mutateAsync({ kind, input: {} })
      .then((res) => {
        handleClose();
        onWorkflowStarted(res.runId);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Could not start the workflow.",
        );
      });
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,0.55)] p-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
          data-testid="unified-catalog-modal-scrim"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="New workflow"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="text-[16px] font-bold text-text">
                New workflow
              </div>
              <button
                type="button"
                onClick={handleClose}
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

            {/* Search */}
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <div className="relative flex-1">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3"
                >
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search…"
                  className="w-full rounded-[8px] border border-border bg-surface-2 py-1.5 pl-8 pr-3 text-[13px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
                />
              </div>
            </div>

            {error && (
              <div className="mx-5 mt-3 rounded-lg border border-orange bg-[rgba(233,132,40,0.12)] px-3 py-2 text-[13px] text-orange-deep">
                {error}
              </div>
            )}

            {/* Grid */}
            <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {workflowsPending && (
                  <p className="col-span-1 py-6 text-center sm:col-span-2 text-[13px] text-text-3">
                    Loading workflows…
                  </p>
                )}
                {!workflowsPending &&
                  filteredWorkflows.map((workflow) => (
                    <div
                      key={workflow.kind}
                      className="flex flex-col justify-between gap-3 rounded-[10px] border border-border p-4 transition-colors hover:bg-[var(--row-hover)]"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="text-[14px] font-semibold text-text">
                          {workflow.label}
                        </p>
                        {workflow.description !== undefined && (
                          <p className="text-[12px] leading-snug text-text-3 text-pretty">
                            {workflow.description}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={startWorkflow.isPending}
                        onClick={() => handleStartWorkflow(workflow.kind)}
                        className="self-start rounded-[7px] border border-border px-3 py-1 text-[12px] font-semibold text-text-2 transition-colors active:scale-[0.97] disabled:opacity-50 hover:border-orange hover:text-orange"
                      >
                        {startingKind === workflow.kind ? "Starting…" : "Start"}
                      </button>
                    </div>
                  ))}
                {!workflowsPending &&
                  filteredWorkflows.length === 0 &&
                  deployedWorkflows.length === 0 && (
                    <p className="col-span-1 py-6 text-center sm:col-span-2 text-[13px] text-text-3">
                      No workflows deployed yet.
                    </p>
                  )}
                {!workflowsPending &&
                  filteredWorkflows.length === 0 &&
                  deployedWorkflows.length > 0 && (
                    <p className="col-span-1 py-6 text-center sm:col-span-2 text-[13px] text-text-3">
                      No workflows match your search.
                    </p>
                  )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
