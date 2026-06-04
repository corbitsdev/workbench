import { useState } from 'react';
import { OnboardingView } from '@workbench/auth';
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

  const handleSubmit = async () => {
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
    <OnboardingView
      state={{ name, loading, error }}
      onNameChange={setName}
      onSubmit={handleSubmit}
    />
  );
}
