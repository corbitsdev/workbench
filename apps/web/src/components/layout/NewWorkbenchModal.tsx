import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Input, Label } from '../auth/Field';
import { createWorkbench } from '../../lib/hub-api';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface NewWorkbenchModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (slug: string) => void;
}

export function NewWorkbenchModal({ open, onClose, onCreated }: NewWorkbenchModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setLoading(false);
    setError(null);
  };

  const handleClose = () => {
    reset();
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    if (!slugify(trimmed)) {
      setError('Workbench name must contain at least one letter or number.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const created = await createWorkbench(trimmed);
      reset();
      onCreated(created.slug);
    } catch (err) {
      const status =
        err !== null && typeof err === 'object' && 'status' in err
          ? (err as { status: unknown }).status
          : undefined;
      if (status === 409) {
        setError('That workbench name is already taken. Please choose a different name.');
      } else {
        setError(
          err instanceof Error ? err.message : 'Failed to create workbench. Please try again.'
        );
      }
      setLoading(false);
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
          data-testid="new-workbench-modal-scrim"
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Create workbench"
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
              <div className="text-[16px] font-bold text-text">Create workbench</div>
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

            <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-6 py-5">
              {error && (
                <p className="rounded-lg border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep">
                  {error}
                </p>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-workbench-name">Workbench name</Label>
                <Input
                  id="new-workbench-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Sales"
                  maxLength={100}
                  autoFocus
                />
              </div>
              <button
                type="submit"
                disabled={loading || name.trim().length === 0}
                className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-text hover:bg-orange-deep disabled:opacity-50"
              >
                {loading ? 'Creating workbench...' : 'Create workbench'}
              </button>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
