import { AuthLayout } from './AuthLayout';
import { GoogleIcon } from './GoogleIcon';
import { type LoginFormState, type OAuthProviderDescriptor, type OAuthProviderId } from './types';

/** Default set of providers shown on the login surface. */
export const DEFAULT_OAUTH_PROVIDERS: readonly OAuthProviderDescriptor[] = [
  { id: 'google', label: 'Continue with Google' },
];

export interface LoginViewProps {
  /** Current form state (loading / error). Owned by the consuming app. */
  state: LoginFormState;
  /** Invoked when a provider button is clicked. */
  onOAuth: (provider: OAuthProviderId) => void;
  /** Providers to render. Defaults to Google only. */
  providers?: readonly OAuthProviderDescriptor[];
}

/**
 * Stateless login presentation. The consuming app owns auth-client wiring and
 * supplies form state plus the OAuth handler. This view renders the brand shell
 * and a button per provider.
 */
export function LoginView({ state, onOAuth, providers = DEFAULT_OAUTH_PROVIDERS }: LoginViewProps) {
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
          <p className="text-sm text-text-2">Use your Google account to continue.</p>
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
      </div>
    </AuthLayout>
  );
}
