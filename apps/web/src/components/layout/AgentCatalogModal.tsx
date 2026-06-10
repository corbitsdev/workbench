import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { deployAgentFromTemplate, listAgentTemplates, type AgentCatalogEntry } from '../../lib/hub-api';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export interface AgentCatalogModalProps {
  open: boolean;
  tenantId: string | null;
  onClose: () => void;
  onDeployed: () => void;
}

export function AgentCatalogModal({ open, tenantId, onClose, onDeployed }: AgentCatalogModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [deploying, setDeploying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: catalog = [] } = useQuery<AgentCatalogEntry[]>({
    queryKey: ['agent-templates'],
    queryFn: listAgentTemplates,
    enabled: open,
  });

  const handleClose = () => {
    setError(null);
    onClose();
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onClose]
  );

  useEffect(() => {
    if (!open || !panelRef.current) return;
    const items = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    (items[0] ?? panelRef.current).focus();
  }, [open]);

  const handleDeploy = async (entry: AgentCatalogEntry) => {
    if (!tenantId || deploying) return;
    setDeploying(entry.key);
    setError(null);
    try {
      await deployAgentFromTemplate(tenantId, entry.key);
      handleClose();
      onDeployed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deploy agent. Please try again.');
    } finally {
      setDeploying(null);
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
          onClick={handleClose}
          data-testid="agent-catalog-modal-scrim"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Add agent"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18 }}
            className="flex w-full max-w-sm flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-[0_10px_40px_rgba(0,0,0,0.4)] focus:outline-none"
          >
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div className="text-[16px] font-bold text-text">Add agent</div>
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

            <div className="flex flex-col gap-2 px-4 py-4">
              {error && (
                <p className="rounded-lg border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep">
                  {error}
                </p>
              )}
              {catalog.map((entry) => (
                <div
                  key={entry.key}
                  className="flex items-center gap-3 rounded-[12px] border border-border px-4 py-3 transition-colors hover:bg-[var(--row-hover)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-text">{entry.name}</div>
                    <div className="mt-0.5 text-[12px] text-text-3">{entry.description}</div>
                  </div>
                  <button
                    type="button"
                    disabled={deploying !== null || !tenantId}
                    onClick={() => void handleDeploy(entry)}
                    className="flex-none rounded-[8px] border border-border px-3 py-1.5 text-[12px] font-semibold text-text-2 transition-colors hover:border-orange hover:text-orange disabled:opacity-50"
                  >
                    {deploying === entry.key ? 'Adding…' : 'Add'}
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
