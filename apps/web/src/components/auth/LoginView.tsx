import { useState } from 'react';
import { AuthLayout } from './AuthLayout';
import { GoogleIcon } from './GoogleIcon';
import {
  type EmailPasswordCredentials,
  type LoginFormState,
  type OAuthProviderDescriptor,
  type OAuthProviderId,
} from './types';

/** Default set of providers shown on the login surface. */
export const DEFAULT_OAUTH_PROVIDERS: readonly OAuthProviderDescriptor[] = [
  { id: 'google', label: 'Continue with Google' },
];

export interface LoginViewProps {
  /** Current form state (loading / error). Owned by the app. */
  state: LoginFormState;
  /** Invoked when a provider button is clicked. */
  onOAuth: (provider: OAuthProviderId) => void;
  /** Providers to render. Defaults to Google only. */
  providers?: readonly OAuthProviderDescriptor[];
  /** When provided, renders an email/password form below the OAuth buttons. */
  onEmailPassword?: (credentials: EmailPasswordCredentials) => void;
}

/**
 * Stateless login presentation. The app owns auth-client wiring and supplies
 * form state plus the OAuth handler. This view renders the brand shell and a
 * button per provider.
 */
export function LoginView({
  state,
  onOAuth,
  providers = DEFAULT_OAUTH_PROVIDERS,
  onEmailPassword,
}: LoginViewProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        {/* Mobile brand header */}
        <div className="flex flex-col gap-2 lg:hidden">
          <div className="flex items-center gap-2.5 text-lg font-semibold tracking-tight text-text">
            <div className="h-7 w-7 rounded bg-orange" />
            GTM Workbench
          </div>
          <p className="text-sm text-text-2">Sales collateral workbench</p>
        </div>

        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold text-text">Sign in</h1>
          <p className="text-sm text-text-2">
            {onEmailPassword ? 'Sign in to continue.' : 'Use your Google account to continue.'}
          </p>
        </div>

        {state.error && (
          <p className="rounded-lg border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep">
            {state.error}
          </p>
        )}

        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => onOAuth(provider.id)}
            disabled={state.loading}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-surface-2 px-4 py-2 text-sm font-medium text-text hover:bg-surface disabled:opacity-50"
          >
            <GoogleIcon className="h-4 w-4" />
            {state.loading ? 'Redirecting…' : provider.label}
          </button>
        ))}

        {onEmailPassword && (
          <>
            {providers.length > 0 && (
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-text-3">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                onEmailPassword({ email, password });
              }}
            >
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state.loading}
                required
                className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-border-focus disabled:opacity-50"
              />
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={state.loading}
                required
                className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-border-focus disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={state.loading}
                className="w-full rounded-md bg-orange px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {state.loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
