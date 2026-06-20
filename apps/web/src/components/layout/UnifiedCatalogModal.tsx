import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import {
  deployAgentFromTemplate,
  listAgentTemplates,
  type AgentCatalogEntry,
} from '../../lib/hub-api';
import { toHumanLabel } from '@workbench/ui';
import { useWorkflowRuns, useStartWorkflow } from '../../hooks/use-workflow';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

const TOOL_PROVIDER_LABELS: Record<string, string> = {
  granola: 'Granola',
  firecrawl: 'Firecrawl',
  gamma: 'Gamma',
  exa: 'Exa',
  reddit: 'Reddit',
  scrapecreators: 'ScrapeCreators',
};

function deriveProviderLabels(tools: string[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const tool of tools) {
    const prefix = tool.split('_')[0];
    if (prefix && TOOL_PROVIDER_LABELS[prefix] && !seen.has(prefix)) {
      seen.add(prefix);
      labels.push(TOOL_PROVIDER_LABELS[prefix]!);
    }
  }
  return labels;
}

type Tab = 'agents' | 'workflows';

export interface UnifiedCatalogModalProps {
  open: boolean;
  tenantId: string | null;
  onClose: () => void;
  onAgentDeployed: () => void;
  onWorkflowStarted: (deploymentId: string) => void;
  // Controls which tab opens by default when the modal opens.
  defaultTab?: Tab;
}

// Dumb launcher. Lists deployed agent templates and workflow kinds; clicking a
// workflow card starts a run immediately and hands the new deploymentId back.
// There is no pre-workflow screen — the run's own Panel renders the experience.
export function UnifiedCatalogModal({
  open,
  tenantId,
  onClose,
  onAgentDeployed,
  onWorkflowStarted,
  defaultTab = 'agents',
}: UnifiedCatalogModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(defaultTab);
  const [search, setSearch] = useState('');
  const [deploying, setDeploying] = useState<string | null>(null);
  const [startingKind, setStartingKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: agentCatalog = [] } = useQuery<AgentCatalogEntry[]>({
    queryKey: ['agent-templates'],
    queryFn: listAgentTemplates,
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const { data: workflowRuns = [], isPending: workflowsPending } = useWorkflowRuns();
  const startWorkflow = useStartWorkflow();

  const deployedKinds = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const run of workflowRuns) {
      if (!seen.has(run.kind)) {
        seen.add(run.kind);
        result.push(run.kind);
      }
    }
    return result;
  }, [workflowRuns]);

  const handleClose = useCallback(() => {
    setError(null);
    setSearch('');
    setTab(defaultTab);
    onClose();
  }, [onClose, defaultTab]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
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
    [handleClose]
  );

  // Focus the first interactive element whenever the modal opens. This is a DOM
  // mutation — useLayoutEffect runs synchronously after the DOM updates, before
  // the browser paints, which prevents flicker.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;
    const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    (items[0] ?? panelRef.current).focus();
  }, [open]);

  const query = search.toLowerCase();

  const filteredAgents = agentCatalog.filter(
    (a) => a.name.toLowerCase().includes(query) || a.description.toLowerCase().includes(query)
  );

  const filteredWorkflowKinds = deployedKinds.filter((kind) =>
    toHumanLabel(kind).toLowerCase().includes(query)
  );

  const handleDeployAgent = async (entry: AgentCatalogEntry) => {
    if (!tenantId || deploying) return;
    setDeploying(entry.key);
    setError(null);
    try {
      await deployAgentFromTemplate(tenantId, entry.key);
      handleClose();
      onAgentDeployed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add agent');
    } finally {
      setDeploying(null);
    }
  };

  const handleStartWorkflow = (kind: string) => {
    if (startingKind) return;
    setStartingKind(kind);
    setError(null);
    startWorkflow
      .mutateAsync({ kind, input: {} })
      .then((res) => {
        handleClose();
        onWorkflowStarted(res.deploymentId);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not start the workflow.');
      })
      .finally(() => {
        setStartingKind(null);
      });
  };

  const isGridBusy = deploying !== null || startingKind !== null;

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
            aria-label="Add agent or workflow"
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
              <div className="text-[16px] font-bold text-text">New</div>
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close"
                className="grid h-8 w-8 flex-none place-items-center rounded-[9px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>

            {/* Tabs + search */}
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <div className="flex gap-1 rounded-[8px] bg-surface-2 p-[3px]">
                {(['agents', 'workflows'] as Tab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setTab(t);
                      setSearch('');
                      setError(null);
                    }}
                    className={`rounded-[6px] px-3 py-1 text-[13px] font-medium capitalize transition-colors ${
                      tab === t ? 'bg-surface text-text shadow-sm' : 'text-text-2 hover:text-text'
                    }`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              <div className="relative flex-1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3">
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
              {tab === 'agents' && (
                <div className="grid grid-cols-2 gap-2">
                  {filteredAgents.map((entry) => {
                    const labels = deriveProviderLabels(entry.tools);
                    return (
                      <div key={entry.key} className="flex flex-col justify-between gap-3 rounded-[10px] border border-border p-4 transition-colors hover:bg-[var(--row-hover)]">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[14px] font-semibold text-text">{entry.name}</span>
                            {labels.map((label) => (
                              <span key={label} className="rounded-[5px] bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-text-2">{label}</span>
                            ))}
                          </div>
                          <p className="mt-1 text-[12px] leading-[1.4] text-text-3">{entry.description}</p>
                        </div>
                        <button
                          type="button"
                          disabled={isGridBusy || !tenantId}
                          onClick={() => void handleDeployAgent(entry)}
                          className="self-start rounded-[7px] border border-border px-3 py-1 text-[12px] font-semibold text-text-2 transition-colors active:scale-[0.97] disabled:opacity-50 hover:border-orange hover:text-orange"
                        >
                          {deploying === entry.key ? 'Adding…' : 'Add'}
                        </button>
                      </div>
                    );
                  })}
                  {filteredAgents.length === 0 && (
                    <p className="col-span-2 py-6 text-center text-[13px] text-text-3">No agents match your search.</p>
                  )}
                </div>
              )}

              {tab === 'workflows' && (
                <div className="grid grid-cols-2 gap-2">
                  {workflowsPending && (
                    <p className="col-span-2 py-6 text-center text-[13px] text-text-3">Loading workflows…</p>
                  )}
                  {!workflowsPending &&
                    filteredWorkflowKinds.map((kind) => (
                      <div key={kind} className="flex flex-col justify-between gap-3 rounded-[10px] border border-border p-4 transition-colors hover:bg-[var(--row-hover)]">
                        <div className="min-w-0">
                          <p className="text-[14px] font-semibold text-text">{toHumanLabel(kind)}</p>
                        </div>
                        <button
                          type="button"
                          disabled={isGridBusy}
                          onClick={() => handleStartWorkflow(kind)}
                          className="self-start rounded-[7px] border border-border px-3 py-1 text-[12px] font-semibold text-text-2 transition-colors active:scale-[0.97] disabled:opacity-50 hover:border-orange hover:text-orange"
                        >
                          {startingKind === kind ? 'Starting…' : 'Start'}
                        </button>
                      </div>
                    ))}
                  {!workflowsPending && filteredWorkflowKinds.length === 0 && deployedKinds.length === 0 && (
                    <p className="col-span-2 py-6 text-center text-[13px] text-text-3">No workflows deployed yet.</p>
                  )}
                  {!workflowsPending && filteredWorkflowKinds.length === 0 && deployedKinds.length > 0 && (
                    <p className="col-span-2 py-6 text-center text-[13px] text-text-3">No workflows match your search.</p>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
