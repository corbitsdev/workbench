import { useState } from 'react';
import { Button } from '@workbench/ui';
import type { IntakeFormProps } from './types';

export function IntakeForm({ onSubmit, onCancel }: IntakeFormProps) {
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [keyPoints, setKeyPoints] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        topic: topic.trim(),
        audience: audience.trim() || undefined,
        keyPoints: keyPoints.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="topic" className="text-sm font-medium text-text">
          Topic / title <span className="text-orange">*</span>
        </label>
        <input
          id="topic"
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. Q3 Product Roadmap"
          required
          disabled={submitting}
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="audience" className="text-sm font-medium text-text">
          Target audience
        </label>
        <input
          id="audience"
          type="text"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          placeholder="e.g. Engineering leads, executive team"
          disabled={submitting}
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="keyPoints" className="text-sm font-medium text-text">
          Key points to cover
        </label>
        <textarea
          id="keyPoints"
          value={keyPoints}
          onChange={(e) => setKeyPoints(e.target.value)}
          placeholder="List the main points you want the presentation to address"
          rows={4}
          disabled={submitting}
          className="resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange"
        />
      </div>

      {error && <p className="text-sm text-orange">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !topic.trim()}>
          {submitting ? 'Starting…' : 'Start'}
        </Button>
      </div>
    </form>
  );
}
