import { useState } from 'react';
import { useNavigate } from 'react-router';
import { authClient } from '../lib/auth-client';

function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left — brand panel */}
      <div className="relative hidden flex-col justify-between bg-charcoal p-10 text-text lg:flex">
        <div className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <div className="h-7 w-7 rounded bg-orange" />
          GTM Workbench
        </div>
        <div className="max-w-sm">
          <blockquote className="text-lg font-medium leading-relaxed text-text-2">
            "Turn sales call transcripts into publishable collateral."
          </blockquote>
          <p className="mt-4 text-sm text-text-3">
            AI-assisted workbench for extracting pain points and generating follow-up content.
          </p>
        </div>
        <p className="text-xs text-text-3">Powered by Interchange</p>
      </div>

      {/* Right — form */}
      <div className="flex flex-col bg-surface">
        <div className="flex flex-1 items-center justify-center p-6 md:p-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('alice@example.com');
  const [password, setPassword] = useState('password123');
  const [useEmailPassword, setUseEmailPassword] = useState(false);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await authClient.signIn.social({
        provider: 'google',
        callbackURL: window.location.origin,
      });
    } catch {
      setError('Failed to sign in with Google. Please try again.');
      setLoading(false);
    }
  };

  const handleEmailPasswordSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({
        email,
        password,
      });
      if (result.data?.user) {
        navigate('/');
      }
    } catch {
      setError('Failed to sign in. Check your email and password.');
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        {/* Mobile brand header */}
        <div className="flex flex-col gap-2 lg:hidden">
          <div className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-text">
            <div className="h-7 w-7 rounded bg-orange" />
            GTM Workbench
          </div>
          <p className="text-sm text-text-2">Sales collateral workspace</p>
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-text">Sign in</h1>
          <p className="text-sm text-text-2">
            {useEmailPassword
              ? 'Sign in with email and password.'
              : 'Use your Google account to continue.'}
          </p>
        </div>

        {error && (
          <p className="rounded-lg border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep">
            {error}
          </p>
        )}

        {useEmailPassword ? (
          <form onSubmit={handleEmailPasswordSignIn} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="email" className="text-sm font-medium text-text">
                Email
              </label>
              <input
                type="email"
                id="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
                placeholder="alice@example.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="password" className="text-sm font-medium text-text">
                Password
              </label>
              <input
                type="password"
                id="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-2 focus:ring-orange"
                placeholder="password123"
              />
            </div>
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-text hover:bg-orange-deep disabled:opacity-50"
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => setUseEmailPassword(false)}
              className="text-sm text-text-2 hover:text-text"
            >
              Use Google instead
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={loading}
              className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text hover:bg-surface disabled:opacity-50"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
              {loading ? 'Redirecting…' : 'Continue with Google'}
            </button>
            <button
              type="button"
              onClick={() => setUseEmailPassword(true)}
              className="text-sm text-text-2 hover:text-text"
            >
              Sign in with email instead
            </button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
