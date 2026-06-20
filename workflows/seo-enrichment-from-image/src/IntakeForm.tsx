import { useState } from 'react';
import { Button } from '@workbench/ui';

interface IntakeFormProps {
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function IntakeForm({ onSubmit, onCancel }: IntakeFormProps) {
  const [imageUrl, setImageUrl] = useState('');
  const [pageUrl, setPageUrl] = useState('');
  const [keywords, setKeywords] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imageUrlValid = imageUrl.trim().length > 0 && isValidUrl(imageUrl.trim());
  const pageUrlValid = pageUrl.trim().length > 0;
  const canSubmit = imageUrlValid && pageUrlValid && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        imageUrl: imageUrl.trim(),
        pageUrl: pageUrl.trim(),
        keywords: keywords.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="imageUrl" className="text-sm font-medium text-text">
          Image URL <span className="text-orange">*</span>
        </label>
        <input
          id="imageUrl"
          type="url"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
          placeholder="https://example.com/product-image.jpg"
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-orange"
          disabled={submitting}
          required
        />
        {imageUrl.trim().length > 0 && !imageUrlValid && (
          <p className="text-xs text-red-500">Enter a valid URL.</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="pageUrl" className="text-sm font-medium text-text">
          Target page URL <span className="text-orange">*</span>
        </label>
        <input
          id="pageUrl"
          type="text"
          value={pageUrl}
          onChange={(e) => setPageUrl(e.target.value)}
          placeholder="https://example.com/product-page"
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-orange"
          disabled={submitting}
          required
        />
        <p className="text-xs text-text-muted">The page whose SEO metadata will be enriched.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="keywords" className="text-sm font-medium text-text">
          Focus keywords
        </label>
        <input
          id="keywords"
          type="text"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="product photography, ecommerce, studio lighting"
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-orange"
          disabled={submitting}
        />
        <p className="text-xs text-text-muted">Optional. Comma-separated terms to guide SEO generation.</p>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex justify-end gap-3">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {submitting ? 'Starting…' : 'Start enrichment'}
        </Button>
      </div>
    </form>
  );
}
