import { useState } from 'react';
import { createTenant } from '../lib/hub-api';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function OnboardingPage() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    const slug = slugify(trimmed);
    if (!slug) {
      setError('Workspace name must contain at least one letter or number.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await createTenant(trimmed, slug);
      window.location.replace('/');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create workspace. Please try again.'
      );
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-surface p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 mb-8">
          <div className="h-7 w-7 rounded bg-orange" />
          <span className="text-lg font-semibold tracking-tight text-text">GTM Workbench</span>
        </div>

        <h1 className="text-2xl font-bold text-text mb-2">Create your workspace</h1>
        <p className="text-sm text-text-2 mb-6">
          Your workspace is where your team's collateral lives. You can invite teammates after
          setup.
        </p>

        {error && (
          <p className="rounded-lg border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep mb-4">
            {error}
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="workspace-name" className="text-sm font-medium text-text">
              Workspace name
            </label>
            <input
              id="workspace-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Sales"
              maxLength={100}
              autoFocus
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
            />
          </div>

          <button
            type="submit"
            disabled={loading || name.trim().length === 0}
            className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-text hover:bg-orange-deep disabled:opacity-50"
          >
            {loading ? 'Creating workspace…' : 'Create workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
