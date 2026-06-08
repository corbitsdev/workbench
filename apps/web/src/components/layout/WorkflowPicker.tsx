import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import { useEnabledWorkflows } from '../../hooks/use-workflow';
import { WorkflowCatalogModal } from './WorkflowCatalogModal';

export interface WorkflowPickerProps {
  onSelectKind: (kind: string) => void;
  onClose: () => void;
}

export function WorkflowPicker({ onSelectKind, onClose }: WorkflowPickerProps) {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const { data: enabledWorkflows, isLoading } = useEnabledWorkflows();

  const workflows = enabledWorkflows ?? [];
  const hasWorkflows = workflows.length > 0;

  if (!hasWorkflows && !isLoading) {
    return (
      <WorkflowCatalogModal
        open={true}
        onClose={onClose}
        onInstalled={(kind) => {
          onSelectKind(kind);
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <span className="text-[15px] font-semibold text-text">New workflow</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-7 w-7 place-items-center rounded-[5px] text-text-3 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && <p className="px-3 py-2 text-[12px] text-text-3">Loading workflows...</p>}
        {workflows.map((wf) => (
          <button
            key={wf.kind}
            type="button"
            onClick={() => onSelectKind(wf.kind)}
            className="flex w-full flex-col items-start gap-0.5 rounded-[8px] px-3 py-2 text-left transition-colors hover:bg-[var(--row-hover)]"
          >
            <span className="text-[13px] font-medium text-text">{wf.name}</span>
            {wf.description && <span className="text-[11.5px] text-text-3">{wf.description}</span>}
          </button>
        ))}
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            onClick={() => setCatalogOpen(true)}
            className="flex w-full items-center gap-2 rounded-[8px] px-3 py-2 text-[12px] text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
          >
            <Plus className="h-3.5 w-3.5" />
            Add workflow
          </button>
        </div>
      </div>

      <WorkflowCatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onInstalled={(kind) => {
          setCatalogOpen(false);
          onSelectKind(kind);
        }}
      />
    </div>
  );
}
