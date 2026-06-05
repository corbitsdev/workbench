import { useState } from 'react';
import { useNavigate } from 'react-router';
import { createWorkspace } from '../lib/hub-api';

export function OnboardingPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);

    try {
      await createWorkspace(trimmed);
      void navigate('/');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to create workspace. Please try again.'
      );
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-page">
      <div className="w-full max-w-sm px-4">
        <h1 className="mb-1 text-[18px] font-semibold text-text-1">Create your workspace</h1>
        <p className="mb-6 text-[13px] text-text-3">Give your workspace a name to get started.</p>
        <form onSubmit={(e) => void handleSubmit(e)}>
          <label
            className="mb-1 block text-[13px] font-medium text-text-2"
            htmlFor="workspace-name"
          >
            Workspace name
          </label>
          <input
            id="workspace-name"
            type="text"
            className="mb-4 w-full rounded-md border border-border bg-surface px-3 py-2 text-[14px] text-text-1 placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
            placeholder="Acme Corp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
            autoFocus
            maxLength={100}
          />
          {error !== null && (
            <p role="alert" className="mb-4 text-[13px] text-red-500">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading || name.trim().length === 0}
            className="w-full rounded-md bg-orange px-4 py-2 text-[14px] font-medium text-white transition-opacity disabled:opacity-50"
          >
            {loading ? 'Creating...' : 'Create workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}
