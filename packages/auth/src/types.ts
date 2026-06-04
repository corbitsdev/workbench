/**
 * View-layer types for the auth presentation package.
 *
 * These types describe the shapes the stateless auth views render from. They
 * carry no behavior: session management, auth-client wiring, and routing all
 * live in the consuming application. The package only knows how to render the
 * login and onboarding surfaces given form state and callbacks.
 */

/** Identifier for a supported social sign-in provider. */
export type OAuthProviderId = 'google';

/**
 * Descriptor for a social sign-in option rendered on the login surface. The
 * view uses this to label and identify the provider button; the consuming app
 * supplies the actual sign-in behavior via the OAuth handler.
 */
export interface OAuthProviderDescriptor {
  /** Stable provider id passed back to the OAuth handler on click. */
  id: OAuthProviderId;
  /** Human-readable label, e.g. "Continue with Google". */
  label: string;
}

/** Form state for the login surface. */
export interface LoginFormState {
  /** Whether a sign-in attempt is in flight. */
  loading: boolean;
  /** Error message to surface, or null when there is none. */
  error: string | null;
}

/** Form state for the onboarding (create workspace) surface. */
export interface OnboardingFormState {
  /** Current workspace name input value. */
  name: string;
  /** Whether a create-workspace attempt is in flight. */
  loading: boolean;
  /** Error message to surface, or null when there is none. */
  error: string | null;
}
