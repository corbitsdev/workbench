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
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    });
    setSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5 p-5">
      <VariantFields label="Variant A" value={variantA} onChange={setVariantA} disabled={submitting} />
      <VariantFields label="Variant B" value={variantB} onChange={setVariantB} disabled={submitting} />
      {error && <p className="text-sm text-orange">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit || submitting}>
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
  disabled,
}: {
  label: string;
  value: Variant;
  onChange: (v: Variant) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-[10px] border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-text">{label}</legend>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-2">Label</label>
        <input
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          placeholder="e.g. Homepage V1"
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
          disabled={disabled}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-2">URL or content</label>
        <input
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
          placeholder="https://example.com or paste text"
          value={value.url}
          onChange={(e) => onChange({ ...value, url: e.target.value })}
          disabled={disabled}
        />
      </div>
    </fieldset>
  );
}
