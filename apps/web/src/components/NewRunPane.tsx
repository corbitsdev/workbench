import { useState } from 'react';
import { Button, toHumanLabel } from '@workbench/ui';
import { useStartWorkflow } from '../hooks/use-workflow';

interface NewRunPaneProps {
  workflowKind: string;
  onStarted: (deploymentId: string) => void;
  onClose: () => void;
}

// Generic "start a run" pane. It posts a free-form JSON input to the native
// start endpoint and hands the resulting deploymentId back to the page, which
// promotes it into a live RunConsole. Per-kind input forms are no longer
// modeled in the UI — the run is driven entirely by the native stream.
export function NewRunPane({ workflowKind, onStarted, onClose }: NewRunPaneProps) {
  const [raw, setRaw] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const start = useStartWorkflow();

  const handleStart = () => {
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      setError('Input must be valid JSON.');
      return;
    }
    setError(null);
    start
      .mutateAsync({ kind: workflowKind, input })
      .then((res) => onStarted(res.deploymentId))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not start the run.');
      });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="truncate text-[14px] font-medium text-text">
          New {toHumanLabel(workflowKind)} run
        </p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <label className="mb-2 block text-[12px] font-medium text-text-2" htmlFor="run-input">
          Input (JSON)
        </label>
        <textarea
          id="run-input"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
          className="h-48 w-full resize-none rounded-[10px] border border-border bg-surface px-3 py-2 font-mono text-[12px] text-text outline-none focus:border-orange"
        />
        {error && <p className="mt-2 text-[12px] text-red-500">{error}</p>}
        <div className="mt-3">
          <Button variant="primary" size="sm" disabled={start.isPending} onClick={handleStart}>
            {start.isPending ? 'Starting…' : 'Start run'}
          </Button>
        </div>
      </div>
    </div>
  );
}
