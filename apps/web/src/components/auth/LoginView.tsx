import { useState } from "react";
import { AuthLayout } from "./AuthLayout";
import { GoogleIcon } from "./GoogleIcon";
import {
  type EmailPasswordCredentials,
  type LoginFormState,
  type OAuthProviderDescriptor,
  type OAuthProviderId,
} from "./types";

/** Default set of providers shown on the login surface. */
export const DEFAULT_OAUTH_PROVIDERS: readonly OAuthProviderDescriptor[] = [
  { id: "google", label: "Continue with Google" },
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <AuthLayout>
      <div className="flex flex-col gap-6">
        <h1 className="text-balance text-[2.75rem] font-normal uppercase leading-none tracking-tight text-text">
          Welcome back
        </h1>

        {state.error && (
          <p
            role="alert"
            aria-live="assertive"
            className="rounded-sm border border-orange bg-orange-soft px-3 py-2 text-sm text-orange-deep"
          >
            {state.error}
          </p>
        )}

        {onEmailPassword && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onEmailPassword({ email, password });
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
              Email
              <input
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={state.loading}
                required
                className="w-full rounded-sm border border-border bg-surface px-4 py-3 text-base font-normal text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-border-focus disabled:opacity-50"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-text">
              Password
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={state.loading}
                required
                className="w-full rounded-sm border border-border bg-surface px-4 py-3 text-base font-normal text-text placeholder:text-text-3 focus:border-border-strong focus:outline-none focus:ring-1 focus:ring-border-focus disabled:opacity-50"
              />
            </label>
            <button
              type="submit"
              disabled={state.loading}
              className="w-full rounded-sm bg-orange px-5 py-3 text-base font-semibold text-white transition hover:bg-orange-deep active:scale-[0.97] disabled:opacity-50"
            >
              {state.loading ? "Signing in…" : "Continue"}
            </button>
          </form>
        )}

        {onEmailPassword && providers.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wider text-text-3">
              or
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        )}

        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => onOAuth(provider.id)}
            disabled={state.loading}
            className="flex w-full items-center justify-center gap-3 rounded-sm border border-border bg-surface px-4 py-3 text-base font-medium text-text transition hover:bg-surface-2 active:scale-[0.97] disabled:opacity-50"
          >
            <GoogleIcon className="h-4 w-4" />
            {provider.label}
          </button>
        ))}
      </div>
    </AuthLayout>
  );
}
