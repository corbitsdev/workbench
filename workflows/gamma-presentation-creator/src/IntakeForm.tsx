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
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="topic" className="text-sm font-medium">
          Topic / title <span className="text-destructive">*</span>
        </label>
        <input
          id="topic"
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. Q3 Product Roadmap"
          required
          className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="audience" className="text-sm font-medium">
          Target audience
        </label>
        <input
          id="audience"
          type="text"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          placeholder="e.g. Engineering leads, executive team"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="keyPoints" className="text-sm font-medium">
          Key points to cover
        </label>
        <textarea
          id="keyPoints"
          value={keyPoints}
          onChange={(e) => setKeyPoints(e.target.value)}
          placeholder="List the main points you want the presentation to address"
          rows={4}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !topic.trim()}>
          {submitting ? 'Starting…' : 'Start'}
        </Button>
      </div>
    </form>
  );
}
