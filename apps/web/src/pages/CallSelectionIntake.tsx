import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import RecentCallsPicker from '../components/RecentCallsPicker';
import { useCreateWorkflow } from '../hooks/use-workflow';
import { buildSteps } from '../lib/steps';
import HorizontalStepper from '../components/HorizontalStepper';
import type { IntakeRequest } from '../types/intake';

const STEP_LABELS = {
  intake: 'Call source',
  analyze: 'Agent review',
  generate: 'Approve collateral',
  improve: 'Improve approved',
  export: 'Final package',
};

const steps = buildSteps('intake', STEP_LABELS);

type IntakeMode = 'paste' | 'recent';

interface CallSelectionIntakeProps {
  onWorkflowCreated: (id: string) => void;
}

export default function CallSelectionIntake({ onWorkflowCreated }: CallSelectionIntakeProps) {
  const [mode, setMode] = useState<IntakeMode>('paste');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const createWorkflow = useCreateWorkflow();

  const handleSubmit = async (data: IntakeRequest) => {
    setError('');
    try {
      const workflow = await createWorkflow.mutateAsync(data);
      onWorkflowCreated(workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow');
    }
  };

  const handlePasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!transcript.trim() || transcript.trim().length < 10) {
      setError('Paste a transcript of at least a few lines.');
      return;
    }
    handleSubmit({ transcript: transcript.trim(), source: 'paste' });
  };

  const isLoading = createWorkflow.isPending;

  return (
    <div className="flex flex-col h-screen bg-page">
      <HorizontalStepper steps={steps} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-6 border-b border-border bg-surface">
          <div className="text-xs font-semibold text-text-3 uppercase tracking-wide mb-2">
            Step 1
          </div>
          <h2 className="text-2xl font-bold text-text">Select a call</h2>
          <p className="text-sm text-text-2 mt-1">Paste a transcript or pick from recent calls</p>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* Mode tabs */}
          <div className="flex gap-2 mb-6 p-1 bg-surface-2 rounded-lg w-64">
            {(['paste', 'recent'] as IntakeMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
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
                className="space-y-4 max-w-2xl"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <textarea
                  value={transcript}
                  onChange={(e) => {
                    setTranscript(e.target.value);
                    setError('');
                  }}
                  placeholder="Speaker 1: Thanks for taking the time today..."
                  className="w-full h-72 px-4 py-3 border border-border rounded-lg focus:ring-2 focus:ring-orange focus:border-transparent resize-none font-mono text-sm bg-surface text-text"
                  disabled={isLoading}
                />
                {error && <p className="text-sm text-orange">{error}</p>}
                <button
                  type="submit"
                  disabled={isLoading || !transcript.trim()}
                  className="px-6 py-2.5 bg-orange text-white font-medium rounded-lg hover:bg-orange-deep disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isLoading ? 'Starting...' : 'Start'}
                </button>
              </motion.form>
            ) : (
              <motion.div
                key="recent"
                className="max-w-2xl"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                {error && <p className="text-sm text-orange mb-4">{error}</p>}
                <RecentCallsPicker onSelect={handleSubmit} isLoading={isLoading} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
