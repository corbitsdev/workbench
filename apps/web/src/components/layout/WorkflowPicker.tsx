import { useState } from 'react';
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
      <>
        <WorkflowCatalogModal
          open={true}
          onClose={onClose}
          onInstalled={(kind) => {
            onSelectKind(kind);
          }}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1 py-1">
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
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              className="h-3.5 w-3.5"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
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
    </>
  );
}
