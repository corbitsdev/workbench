import { useState } from 'react';
import { Button } from '@workbench/ui';

interface IntakeFormProps {
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

function parseCommaSeparated(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function IntakeForm({ onSubmit, onCancel }: IntakeFormProps) {
  const [subreddits, setSubreddits] = useState('');
  const [keywords, setKeywords] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedSubreddits = parseCommaSeparated(subreddits);
  const canSubmit = parsedSubreddits.length > 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        subreddits: parsedSubreddits,
        keywords: parseCommaSeparated(keywords),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="subreddits" className="text-sm font-medium text-text">
          Subreddits <span className="text-orange">*</span>
        </label>
        <input
          id="subreddits"
          type="text"
          value={subreddits}
          onChange={(e) => setSubreddits(e.target.value)}
          placeholder="r/startups, r/SaaS, r/Entrepreneur"
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-orange"
          disabled={submitting}
          required
        />
        <p className="text-xs text-text-muted">Comma-separated list of subreddits to scan.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="keywords" className="text-sm font-medium text-text">
          Keywords to watch for
        </label>
        <input
          id="keywords"
          type="text"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="pricing, alternatives, recommendations"
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-orange"
          disabled={submitting}
        />
        <p className="text-xs text-text-muted">Optional. Comma-separated terms to surface relevant posts.</p>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting ? 'Starting…' : 'Start scan'}
        </Button>
      </div>
    </form>
  );
}
