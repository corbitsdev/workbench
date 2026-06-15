import { useState } from 'react';
import { useArtifacts } from '@workbench/client/react';
import type { PresentationSourceData } from '@workbench/workflow';
import { clientOptions } from '../lib/client-options';
import { resolveKindLabel } from '../lib/resolve-kind-label';

interface ArtifactSourcePickerProps {
  onSelect: (data: PresentationSourceData) => void;
  isLoading?: boolean;
  tenantId?: string | null;
  /** When set, only artifacts of these kinds are offered as sources. */
  kinds?: readonly string[];
  /** Preselect this artifact on mount (e.g. seeded from "Use in Workflow"). */
  initialSelectedId?: string;
}

export default function ArtifactSourcePicker({
  onSelect,
  isLoading = false,
  tenantId,
  kinds,
  initialSelectedId,
}: ArtifactSourcePickerProps) {
  const {
    data: artifacts,
    isLoading: artifactsLoading,
    isError,
  } = useArtifacts(clientOptions, {
    tenantId,
  });
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);

  if (artifactsLoading) {
    return <p className="text-[12px] text-text-2">Loading artifacts…</p>;
  }
  if (isError) {
    return <p className="text-[12px] text-orange">Could not load artifacts.</p>;
  }

  const available = artifacts ?? [];
  const eligible = kinds ? available.filter((a) => kinds.includes(a.kind)) : available;

  if (eligible.length === 0) {
    return <p className="text-[12px] text-text-2">No artifacts available to use as a source.</p>;
  }

  const selected = eligible.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="space-y-3">
      <div className="max-h-72 space-y-1.5 overflow-y-auto">
        {eligible.map((artifact) => {
          const isSelected = artifact.id === selectedId;
          return (
            <button
              key={artifact.id}
              type="button"
              onClick={() => setSelectedId(artifact.id)}
              className={`flex w-full flex-col items-start gap-0.5 rounded-[9px] border px-3 py-2 text-left transition-colors ${
                isSelected
                  ? 'border-orange bg-[var(--row-hover)]'
                  : 'border-border hover:border-border-strong hover:bg-[var(--row-hover)]'
              }`}
            >
              <span className="text-[13px] font-medium text-text">{artifact.title}</span>
              <span className="text-[11.5px] text-text-2">{resolveKindLabel(artifact.kind)}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        disabled={isLoading || selected === null}
        onClick={() => {
          if (!selected) return;
          onSelect({
            source: 'artifact',
            sourceArtifactId: selected.id,
            callTitle: selected.title,
          });
        }}
        className="w-full btn-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading ? 'Saving…' : 'Continue'}
      </button>
    </div>
  );
}
