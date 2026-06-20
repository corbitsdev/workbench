import { useState } from 'react';
import { Button } from '@workbench/ui';
import type { IntakeFormProps } from './types';

interface Variant {
  label: string;
  url: string;
}

function isVariantFilled(v: Variant): boolean {
  return v.label.trim().length > 0 && v.url.trim().length > 0;
}

export function IntakeForm({ onSubmit, onCancel }: IntakeFormProps) {
  const [variantA, setVariantA] = useState<Variant>({ label: '', url: '' });
  const [variantB, setVariantB] = useState<Variant>({ label: '', url: '' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = isVariantFilled(variantA) && isVariantFilled(variantB);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    await onSubmit({ variantA, variantB }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    });
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <VariantFields label="Variant A" value={variantA} onChange={setVariantA} />
      <VariantFields label="Variant B" value={variantB} onChange={setVariantB} />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || submitting}>
          {submitting ? 'Starting…' : 'Start comparison'}
        </Button>
      </div>
    </form>
  );
}

function VariantFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Variant;
  onChange: (v: Variant) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-text">{label}</legend>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-muted">Label</label>
        <input
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-orange"
          placeholder="e.g. Homepage V1"
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-muted">URL or content</label>
        <input
          className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-orange"
          placeholder="https://example.com or paste text"
          value={value.url}
          onChange={(e) => onChange({ ...value, url: e.target.value })}
        />
      </div>
    </fieldset>
  );
}
