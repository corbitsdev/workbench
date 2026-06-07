import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import RecentCallsPicker from './RecentCallsPicker';
import { useCreateWorkflow, useWorkflowTypes } from '../hooks/use-workflow';
import type { IntakeRequest } from '../types/intake';

interface NewWorkflowPaneProps {
  onCreated: (workflowId: string) => void;
  onClose: () => void;
  tenantId?: string | null;
}

type IntakeMode = 'paste' | 'recent';

export function NewWorkflowPane({ onCreated, onClose, tenantId }: NewWorkflowPaneProps) {
  const [mode, setMode] = useState<IntakeMode>('paste');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [selectedKind, setSelectedKind] = useState('collateral-generation');
  const createWorkflow = useCreateWorkflow();
  const { data: workflowTypes } = useWorkflowTypes();

  const handleSubmit = async (data: IntakeRequest) => {
    setError('');
    try {
      const workflow = await createWorkflow.mutateAsync({
        ...data,
        workflowKind: selectedKind,
        ...(tenantId ? { tenantId } : {}),
      });
      onCreated(workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job');
    }
  };

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!transcript.trim() || transcript.trim().length < 10) {
      setError('Paste a transcript of at least a few lines.');
      return;
    }
    void handleSubmit({ transcript: transcript.trim(), source: 'paste' });
  };

  const isLoading = createWorkflow.isPending;

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-panel border border-border bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-border bg-surface shrink-0">
        <p className="text-[14px] font-semibold text-text">New job</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close new job"
          className="grid h-[28px] w-[28px] flex-none place-items-center rounded-[8px] border border-border text-text-2 hover:text-text hover:bg-surface-2 transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-4 w-4"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {/* Workflow type selector — only shown when the server exposes more than one type */}
        {workflowTypes && workflowTypes.length > 1 && (
          <div className="mb-5">
            <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-text-3 mb-2">
              Workflow type
            </p>
            <div className="flex flex-col gap-2">
              {workflowTypes.map((wt) => (
                <button
                  key={wt.kind}
                  type="button"
                  onClick={() => setSelectedKind(wt.kind)}
                  className={`text-left rounded-[10px] border px-3 py-2.5 transition-colors ${
                    selectedKind === wt.kind
                      ? 'border-orange bg-[rgba(233,132,40,0.08)] text-text'
                      : 'border-border text-text-2 hover:border-orange/60 hover:text-text'
                  }`}
                >
                  <p className="text-[13px] font-medium">{wt.name}</p>
                  {wt.description && (
                    <p className="mt-0.5 text-[11.5px] text-text-3">{wt.description}</p>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Mode tabs */}
        <div className="flex gap-1 p-1 bg-surface-2 rounded-[10px] w-52 mb-5">
          {(['paste', 'recent'] as IntakeMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 px-3 py-1.5 rounded-[8px] text-[13px] font-medium transition-colors ${
                mode === m ? 'bg-surface text-text shadow-sm' : 'text-text-2 hover:text-text'
              }`}
            >
              {m === 'paste' ? 'Paste' : 'Recent calls'}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {mode === 'paste' ? (
            <motion.form
              key="paste"
              onSubmit={handlePasteSubmit}
              className="space-y-3"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12 }}
            >
              <textarea
                value={transcript}
                onChange={(e) => {
                  setTranscript(e.target.value);
                  setError('');
                }}
                placeholder="Speaker 1: Thanks for taking the time today..."
                rows={10}
                disabled={isLoading}
                className="w-full px-3 py-3 text-[13px] border border-border rounded-lg bg-surface-2 text-text font-mono resize-none focus:outline-none focus:ring-2 focus:ring-orange disabled:opacity-50"
              />
              {error && <p className="text-[12px] text-orange">{error}</p>}
              <button
                type="submit"
                disabled={isLoading || !transcript.trim()}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Starting…' : 'Start analysis'}
              </button>
            </motion.form>
          ) : (
            <motion.div
              key="recent"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.12 }}
            >
              {error && <p className="text-[12px] text-orange mb-3">{error}</p>}
              <RecentCallsPicker onSelect={handleSubmit} isLoading={isLoading} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
