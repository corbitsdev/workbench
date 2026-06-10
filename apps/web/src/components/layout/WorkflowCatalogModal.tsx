import { useCallback, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useWorkflowCatalog,
  useEnabledWorkflows,
  useInstallWorkflow,
  useWorkflowTools,
  type WorkflowCatalogEntry,
  type WorkflowAssignments,
} from '../../hooks/use-workflow';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export interface WorkflowCatalogModalProps {
  open: boolean;
  onClose: () => void;
  onInstalled: (kind: string) => void;
  tenantId?: string | null;
}

export function WorkflowCatalogModal({
  open,
  onClose,
  onInstalled,
  tenantId,
}: WorkflowCatalogModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const catalogQuery = useWorkflowCatalog();
  const enabledQuery = useEnabledWorkflows(tenantId);
  const toolsQuery = useWorkflowTools();
  const installMutation = useInstallWorkflow(tenantId);

  // Phase 2 state: the workflow being configured before install.
  const [configuring, setConfiguring] = useState<WorkflowCatalogEntry | null>(null);
  // tool selection keyed by stepName.
  const [toolsByStep, setToolsByStep] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

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

  const enabledByKind = new Map((enabledQuery.data ?? []).map((e) => [e.kind, e]));
  const catalog = catalogQuery.data ?? [];
  const toolMeta = new Map((toolsQuery.data ?? []).map((t) => [t.name, t]));

  const startConfigure = (entry: WorkflowCatalogEntry) => {
    const existing = enabledByKind.get(entry.kind);
    const tools: Record<string, string[]> = {};
    for (const step of entry.steps) {
      const assigned = existing?.assignments?.[step.name];
      // Default to the step's full tool set, or the previously saved selection.
      tools[step.name] = assigned?.toolIds ?? step.tools ?? [];
    }
    setToolsByStep(tools);
    setError(null);
    setConfiguring(entry);
  };

  const cancelConfigure = () => {
    setConfiguring(null);
    setError(null);
  };

  const toggleTool = (stepName: string, tool: string) => {
    setToolsByStep((cur) => {
      const set = new Set(cur[stepName] ?? []);
      if (set.has(tool)) set.delete(tool);
      else set.add(tool);
      return { ...cur, [stepName]: [...set] };
    });
  };

  const handleConfirm = async () => {
    if (!configuring) return;
    setError(null);

    const assignments: WorkflowAssignments = {};
    for (const step of configuring.steps) {
      const toolIds = toolsByStep[step.name] ?? [];
      if (toolIds.length > 0) {
        assignments[step.name] = { credentialIds: [], toolIds };
      }
    }

    try {
      await installMutation.mutateAsync({ kind: configuring.kind, assignments });
      const kind = configuring.kind;
      setConfiguring(null);
      onInstalled(kind);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add workflow');
    }
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
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="text-[16px] font-bold text-text">
                {configuring ? `Configure ${configuring.name}` : 'Add workflow'}
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

            {configuring ? (
              <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5">
                {error && (
                  <p className="rounded-lg border border-orange bg-[rgba(233,132,40,0.16)] px-3 py-2 text-[13px] text-orange-deep">
                    {error}
                  </p>
                )}
                {!tenantId && <p className="text-[13px] text-text-2">Select a workbench first.</p>}
                {configuring.steps
                  .filter((step) => (step.tools?.length ?? 0) > 0)
                  .map((step) => (
                    <div
                      key={step.name}
                      className="flex flex-col gap-3 rounded-[10px] border border-border p-4"
                    >
                      <div>
                        <p className="text-[14px] font-medium text-text">{step.label}</p>
                        {step.description && (
                          <p className="mt-0.5 text-[12px] text-text-3">{step.description}</p>
                        )}
                      </div>

                      {(step.tools?.length ?? 0) > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[13px] font-medium text-text">Tools</span>
                          {(step.tools ?? []).map((tool) => (
                            <label
                              key={tool}
                              className="flex items-center gap-2 text-[13px] text-text-2"
                            >
                              <input
                                type="checkbox"
                                checked={(toolsByStep[step.name] ?? []).includes(tool)}
                                onChange={() => toggleTool(step.name, tool)}
                              />
                              <span>{toolMeta.get(tool)?.description ?? tool}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={installMutation.isPending || !tenantId}
                    onClick={() => void handleConfirm()}
                    className="flex-1 rounded-[9px] bg-orange px-4 py-2 text-[13px] font-medium text-white hover:bg-orange-deep disabled:opacity-50"
                  >
                    {installMutation.isPending ? 'Adding…' : 'Add to workbench'}
                  </button>
                  <button
                    type="button"
                    onClick={cancelConfigure}
                    className="rounded-[9px] border border-border px-4 py-2 text-[13px] text-text-2 hover:text-text"
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 overflow-y-auto px-6 py-5">
                {catalogQuery.isLoading && (
                  <p className="text-[13px] text-text-3">Loading catalog...</p>
                )}
                {catalogQuery.isError && (
                  <p className="text-[13px] text-orange">Failed to load workflow catalog.</p>
                )}
                {catalog.map((entry) => {
                  const isInstalled = enabledByKind.has(entry.kind);
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
                      <button
                        type="button"
                        onClick={() => startConfigure(entry)}
                        className="flex-none rounded-[9px] border border-border px-3 py-1.5 text-[12px] font-medium text-text-2 hover:border-orange hover:text-text"
                      >
                        {isInstalled ? 'Edit' : 'Configure'}
                      </button>
                    </div>
                  );
                })}
                {!catalogQuery.isLoading && catalog.length === 0 && (
                  <p className="text-[13px] text-text-3">No workflows available.</p>
                )}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
