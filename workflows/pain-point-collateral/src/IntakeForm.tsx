import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type } from 'arktype';
import { Button } from '@workbench/ui';
import type { IntakeFormProps } from './registry-types';

const GranolaNoteSummarySchema = type({
  id: 'string',
  title: 'string | null',
  created_at: 'string',
});

const GranolaNotesResponseSchema = type({ notes: GranolaNoteSummarySchema.array() });

type GranolaNoteSummary = typeof GranolaNoteSummarySchema.infer;

async function fetchGranolaNoteSummaries(): Promise<GranolaNoteSummary[]> {
  const res = await fetch('/api/v1/granola/notes', { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`Failed to load notes: HTTP ${res.status}`);
  }
  const raw = await res.json();
  const parsed = GranolaNotesResponseSchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected notes response: ${parsed.summary}`);
  }
  return parsed.notes;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function IntakeForm({ onSubmit, onCancel }: IntakeFormProps) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { data: notes, isLoading, isError } = useQuery({
    queryKey: ['granola-notes'],
    queryFn: fetchGranolaNoteSummaries,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const filtered = (notes ?? []).filter((n) => {
    const title = n.title ?? '';
    return title.toLowerCase().includes(search.toLowerCase());
  });

  const selected = (notes ?? []).find((n) => n.id === selectedId) ?? null;

  async function handleSubmit() {
    if (!selected) return;
    setSubmitError(null);
    setIsSubmitting(true);
    await onSubmit({
      noteId: selected.id,
      title: selected.title ?? '',
    }).catch((err: unknown) => {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    });
    setIsSubmitting(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-semibold text-text">Select a meeting note</h2>
        <p className="text-xs text-text-2 mt-0.5">
          Choose a Granola note to analyze for pain points.
        </p>
      </div>

      {isLoading && (
        <p className="text-sm text-text-2">Loading notes…</p>
      )}

      {(isError || (!isLoading && notes === undefined)) && (
        <p className="text-sm text-text-2">
          No notes available. Connect Granola to get started.
        </p>
      )}

      {!isLoading && notes !== undefined && (
        <>
          <input
            type="search"
            placeholder="Search notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-2 focus:outline-none focus:ring-2 focus:ring-orange"
          />

          {filtered.length === 0 ? (
            <p className="text-sm text-text-2">No notes match your search.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-1.5">
              {filtered.map((note) => {
                const isSelected = note.id === selectedId;
                return (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => setSelectedId(note.id)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-[9px] border px-3 py-2 text-left transition-colors ${
                      isSelected
                        ? 'border-orange bg-orange/10'
                        : 'border-border bg-surface-2 hover:bg-surface-2/80'
                    }`}
                  >
                    <span className="text-sm font-medium text-text">
                      {note.title ?? 'Untitled'}
                    </span>
                    <span className="text-xs text-text-2">{formatDate(note.created_at)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {submitError && (
        <p className="text-sm text-orange">{submitError}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={!selected || isSubmitting}
        >
          {isSubmitting ? 'Starting…' : 'Start'}
        </Button>
      </div>
    </div>
  );
}
