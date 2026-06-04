import { useState } from 'react';
import { LoginView, type OAuthProviderId } from '@workbench/auth';
import { authClient } from '../lib/auth-client';

export function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleOAuth = async (provider: OAuthProviderId) => {
    setLoading(true);
    setError(null);
    try {
      await authClient.signIn.social({
        provider,
        callbackURL: window.location.origin,
      });
    } catch {
      setError('Failed to sign in with Google. Please try again.');
      setLoading(false);
    }
  };

  return <LoginView state={{ loading, error }} onOAuth={handleOAuth} />;
}
