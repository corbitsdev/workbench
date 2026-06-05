import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useQueryClient } from '@tanstack/react-query';
import {
  createCollateralGeneration,
  getArtifacts,
  getCollateralGeneration,
  OUTPUT_TYPE_LABELS,
  OUTPUT_TYPES,
} from '../lib/collateral-api';
import type {
  CollateralGenerationWorkflow,
  GeneratedArtifact,
  OutputType,
} from '../lib/collateral-api';

type PanelStep = 'select' | 'generating' | 'results';

interface Props {
  onClose: () => void;
  onComplete?: () => void;
}

function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-orange border-t-transparent" />
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="h-4 w-4 text-green"
    >
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4 text-red-400"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}

export function CollateralGenerationPanel({ onClose, onComplete }: Props) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<PanelStep>('select');

  // Step 1: select
  const [availableArtifacts, setAvailableArtifacts] = useState<GeneratedArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(true);
  const [selectedInputIds, setSelectedInputIds] = useState<Set<string>>(new Set());
  const [selectedOutputTypes, setSelectedOutputTypes] = useState<Set<OutputType>>(
    new Set(['case-study', 'one-pager', 'email-draft'])
  );

  // Step 2: generating
  const [workflow, setWorkflow] = useState<CollateralGenerationWorkflow | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Step 3: results
  const [finalWorkflow, setFinalWorkflow] = useState<CollateralGenerationWorkflow | null>(null);

  const [error, setError] = useState<string | null>(null);

  // Load available artifacts on mount
  useEffect(() => {
    setArtifactsLoading(true);
    getArtifacts()
      .then((res) => {
        setAvailableArtifacts(res.artifacts);
      })
      .catch(() => {
        // Not fatal — user can still proceed with external artifact IDs
        setAvailableArtifacts([]);
      })
      .finally(() => {
        setArtifactsLoading(false);
      });
  }, []);

  // Poll for workflow completion
  const startPolling = useCallback(
    (workflowId: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        try {
          const wf = await getCollateralGeneration(workflowId);
          setWorkflow(wf);
          if (wf.status === 'done' || wf.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            setFinalWorkflow(wf);
            setStep('results');
            void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
            onComplete?.(); // caller-side hook; gallery refresh is handled via queryClient above
          }
        } catch {
          // Transient error — keep polling
        }
      }, 2000);
    },
    [queryClient, onComplete]
  );

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function toggleInput(id: string) {
    setSelectedInputIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleOutputType(ot: OutputType) {
    setSelectedOutputTypes((prev) => {
      const next = new Set(prev);
      if (next.has(ot)) next.delete(ot);
      else next.add(ot);
      return next;
    });
  }

  async function handleGenerate() {
    if (selectedOutputTypes.size === 0) {
      setError('Select at least one output type.');
      return;
    }
    setError(null);
    try {
      const result = await createCollateralGeneration(
        Array.from(selectedInputIds),
        Array.from(selectedOutputTypes)
      );
      const wf = await getCollateralGeneration(result.id);
      setWorkflow(wf);
      setStep('generating');
      startPolling(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start generation.');
    }
  }

  const outputTypeEntries = OUTPUT_TYPES.map((ot) => ({
    ot,
    label: OUTPUT_TYPE_LABELS[ot],
    state: workflow?.outputs[ot] ?? finalWorkflow?.outputs[ot],
  }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.2 }}
      className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg shadow-[var(--shadow,0_2px_6px_rgba(0,0,0,0.3))]"
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div className="flex-1">
          <h2 className="text-[15px] font-bold tracking-[-0.01em] text-text">
            Generate Collateral
          </h2>
          <p className="mt-0.5 text-[12px] text-text-3">
            Select input artifacts and output types, then run generation.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface hover:text-text"
          aria-label="Close panel"
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

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <AnimatePresence mode="wait">
          {step === 'select' && (
            <motion.div
              key="select"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-6"
            >
              {/* Input artifacts */}
              <section>
                <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.05em] text-text-3">
                  Input Artifacts
                </div>
                {artifactsLoading ? (
                  <div className="flex items-center gap-2 py-3 text-[13px] text-text-3">
                    <Spinner /> Loading artifacts...
                  </div>
                ) : availableArtifacts.length === 0 ? (
                  <p className="py-3 text-[13px] text-text-3">
                    {/* TODO: wire to real artifact pool once artifact ingestion is implemented */}
                    No artifacts available yet. Generation will proceed without pre-selected inputs.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {availableArtifacts.map((a) => (
                      <label
                        key={a.id}
                        className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-border px-3 py-2.5 transition-colors hover:bg-surface"
                      >
                        <input
                          type="checkbox"
                          checked={selectedInputIds.has(a.id)}
                          onChange={() => toggleInput(a.id)}
                          className="h-4 w-4 accent-orange"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-medium text-text">
                            {a.title || a.id}
                          </div>
                          <div className="mt-px font-mono text-[11px] text-text-3">
                            {OUTPUT_TYPE_LABELS[a.kind as OutputType] ?? a.kind} ·{' '}
                            {new Date(a.createdAt).toLocaleDateString()}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </section>

              {/* Output types */}
              <section>
                <div className="mb-2 text-[12px] font-bold uppercase tracking-[0.05em] text-text-3">
                  Output Types
                </div>
                <div className="flex flex-col gap-1.5">
                  {OUTPUT_TYPES.map((ot) => (
                    <label
                      key={ot}
                      className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-border px-3 py-2.5 transition-colors hover:bg-surface"
                    >
                      <input
                        type="checkbox"
                        checked={selectedOutputTypes.has(ot)}
                        onChange={() => toggleOutputType(ot)}
                        className="h-4 w-4 accent-orange"
                      />
                      <span className="text-[13.5px] font-medium text-text">
                        {OUTPUT_TYPE_LABELS[ot]}
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              {error && (
                <p className="rounded-[8px] bg-red-500/10 px-3 py-2 text-[13px] text-red-400">
                  {error}
                </p>
              )}
            </motion.div>
          )}

          {step === 'generating' && (
            <motion.div
              key="generating"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-4"
            >
              <p className="text-[13px] text-text-2">
                Generating collateral. This may take a moment.
              </p>
              <div className="flex flex-col gap-2">
                {outputTypeEntries
                  .filter(({ ot }) => selectedOutputTypes.has(ot))
                  .map(({ ot, label, state }) => (
                    <div
                      key={ot}
                      className="flex items-center gap-3 rounded-[10px] border border-border px-3 py-2.5"
                    >
                      <div className="w-5 flex-none">
                        {!state || state.status === 'pending' || state.status === 'generating' ? (
                          <Spinner />
                        ) : state.status === 'done' ? (
                          <CheckIcon />
                        ) : (
                          <ErrorIcon />
                        )}
                      </div>
                      <span className="text-[13.5px] font-medium text-text">{label}</span>
                      <span className="ml-auto font-mono text-[11px] text-text-3">
                        {state?.status ?? 'pending'}
                      </span>
                    </div>
                  ))}
              </div>
            </motion.div>
          )}

          {step === 'results' && finalWorkflow && (
            <motion.div
              key="results"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col gap-4"
            >
              {(() => {
                const selected = outputTypeEntries.filter(({ ot }) => selectedOutputTypes.has(ot));
                const doneCount = selected.filter(({ state }) => state?.status === 'done').length;
                const total = selected.length;
                const allDone = doneCount === total;
                const noneDone = doneCount === 0;
                return (
                  <p className="text-[13px] text-text-2">
                    {allDone
                      ? 'All outputs generated. Review your artifacts below.'
                      : noneDone
                        ? 'Generation failed for all outputs.'
                        : `${doneCount} of ${total} outputs generated.`}
                  </p>
                );
              })()}
              <div className="flex flex-col gap-3">
                {outputTypeEntries
                  .filter(({ ot }) => selectedOutputTypes.has(ot))
                  .map(({ ot, label, state }) => {
                    if (!state) return null;
                    const isDone = state.status === 'done';
                    const isFailed = state.status === 'failed';
                    return (
                      <div key={ot} className="rounded-[12px] border border-border bg-surface p-4">
                        <div className="flex items-center gap-2">
                          {isDone ? <CheckIcon /> : <ErrorIcon />}
                          <span className="text-[13.5px] font-semibold text-text">{label}</span>
                          <span
                            className={`ml-auto rounded-full px-2 py-0.5 font-mono text-[11px] ${
                              isDone ? 'bg-green/10 text-green' : 'bg-red-500/10 text-red-400'
                            }`}
                          >
                            {isDone ? 'done' : 'failed'}
                          </span>
                        </div>
                        {isDone && state.title && (
                          <p className="mt-2 truncate text-[13px] text-text-2">{state.title}</p>
                        )}
                        {isFailed && (
                          <p className="mt-2 text-[12px] text-red-400">
                            This output could not be generated.
                          </p>
                        )}
                        {isDone && state.artifactId && (
                          <div className="mt-3 flex items-center gap-2">
                            <span className="font-mono text-[11px] text-text-3">
                              ID: {state.artifactId}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      {step === 'select' && (
        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[9px] border border-border px-[13px] py-[7px] text-[12.5px] font-semibold text-text-2 transition-colors hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleGenerate()}
            disabled={selectedOutputTypes.size === 0}
            className="rounded-[9px] border border-charcoal bg-charcoal px-[13px] py-[7px] text-[12.5px] font-semibold text-cream transition-opacity disabled:opacity-40"
          >
            Generate
          </button>
        </div>
      )}

      {step === 'results' && (
        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[9px] border border-charcoal bg-charcoal px-[13px] py-[7px] text-[12.5px] font-semibold text-cream transition-opacity"
          >
            Done
          </button>
        </div>
      )}
    </motion.div>
  );
}
