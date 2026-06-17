import { useState } from 'react';
import {
  useWorkflowCredentials,
  type WorkflowCatalogEntry,
  type WorkflowAssignments,
} from '../hooks/use-workflow';

interface WorkflowConfigPanelProps {
  entry: WorkflowCatalogEntry;
  onBack: () => void;
  onStart: (assignments: WorkflowAssignments) => void;
  isLoading: boolean;
}

export function WorkflowConfigPanel({
  entry,
  onBack,
  onStart,
  isLoading,
}: WorkflowConfigPanelProps) {
  const { data: credentials = [], isLoading: credentialsLoading } = useWorkflowCredentials();

  const llmReq = entry.credentialRequirements.find((r) => r.providerName !== 'granola');

  const [selectedCredentialId, setSelectedCredentialId] = useState<string | null>(
    () => credentials[0]?.id ?? null
  );
  const [model, setModel] = useState<string>(llmReq?.defaultModel ?? '');

  const effectiveCredentialId =
    selectedCredentialId ?? (credentials.length > 0 ? credentials[0]!.id : null);

  function buildAssignments(): WorkflowAssignments {
    if (!effectiveCredentialId) return {};
    const assignments: WorkflowAssignments = {};
    for (const step of entry.steps) {
      const hasLlmReq = step.credentialRequirements.some((r) => r.providerName !== 'granola');
      if (hasLlmReq) {
        assignments[step.name] = {
          credentialIds: [effectiveCredentialId],
          toolIds: [],
          ...(model.trim() ? { model: model.trim() } : {}),
        };
      }
    }
    return assignments;
  }

  const canStart = effectiveCredentialId !== null && model.trim().length > 0 && !credentialsLoading;

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="grid h-7 w-7 flex-none place-items-center rounded-[7px] border border-border text-text-2 transition-colors hover:bg-[var(--row-hover)] hover:text-text"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="text-[15px] font-bold text-text">{entry.name}</span>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col gap-5 px-5 py-5">
        <p className="text-[12px] font-semibold uppercase tracking-[0.04em] text-text-3">
          LLM Configuration
        </p>

        {credentialsLoading ? (
          <p className="text-[13px] text-text-3">Loading credentials…</p>
        ) : credentials.length === 0 ? (
          <p className="text-[13px] text-text-3">
            No LLM credentials configured. Add one in Settings.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-text-2">Credential</label>
              <select
                value={effectiveCredentialId ?? ''}
                onChange={(e) => setSelectedCredentialId(e.target.value || null)}
                className="w-full rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-orange"
              >
                {credentials.map((cred) => (
                  <option key={cred.id} value={cred.id}>
                    {cred.name} ({cred.providerName})
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] text-text-2">Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. claude-sonnet-4-5"
                className="w-full rounded-[8px] border border-border bg-surface-2 px-2.5 py-1.5 text-[13px] text-text placeholder-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
              />
            </div>
          </div>
        )}

        <button
          type="button"
          disabled={!canStart || isLoading}
          onClick={() => onStart(buildAssignments())}
          className="self-start rounded-[8px] border border-orange bg-orange/10 px-4 py-1.5 text-[13px] font-semibold text-orange transition-colors hover:bg-orange/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isLoading ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  );
}
