// The one session boundary: a single probe of better-auth's get-session
// endpoint decides whether the app mounts the shell or the auth screen, and
// the email+password calls live beside it so every /api/auth path is written
// in exactly one file.

import { type } from "arktype";

const SessionUser = type({
  id: "string",
  name: "string",
  email: "string",
});

const SessionPayload = type({ user: SessionUser });

export type SessionUser = typeof SessionUser.infer;

export type SessionState =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "signed-in"; readonly user: SessionUser };

/**
 * Asks the hub whether this browser has a session. better-auth answers 200
 * with a JSON `null` body when there is none, so "signed out" is a normal
 * response here — never a 401 in the log.
 */
export async function fetchSession(): Promise<SessionState> {
  try {
    const response = await fetch("/api/auth/get-session", {
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { kind: "signed-out" };
    if (!response.ok) {
      return {
        kind: "error",
        message: `The server answered ${response.status} for the session check.`,
      };
    }
    const body: unknown = await response.json();
    if (body === null) return { kind: "signed-out" };
    const parsed = SessionPayload(body);
    if (parsed instanceof type.errors) {
      return {
        kind: "error",
        message: `Unexpected session shape: ${parsed.summary}`,
      };
    }
    return { kind: "signed-in", user: parsed.user };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export type AuthResult =
  | { readonly ok: true; readonly user: SessionUser }
  | { readonly ok: false; readonly message: string };

const FailureBody = type({ message: "string" });

async function postAuth(
  path: string,
  body: Record<string, string>,
  doing: string,
): Promise<AuthResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = FailureBody(payload);
      return {
        ok: false,
        message:
          failure instanceof type.errors
            ? `The server answered ${response.status} ${doing}.`
            : failure.message,
      };
    }
    const parsed = SessionPayload(payload);
    if (parsed instanceof type.errors) {
      return {
        ok: false,
        message: `Unexpected response shape ${doing}: ${parsed.summary}`,
      };
    }
    return { ok: true, user: parsed.user };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function signIn(email: string, password: string): Promise<AuthResult> {
  return postAuth("/api/auth/sign-in/email", { email, password }, "signing in");
}

/**
 * Creates the account. better-auth requires a display name; like the CLI's
 * admin bootstrap, it starts as the address's local part until the hub grows
 * a profile editor.
 */
export function signUp(email: string, password: string): Promise<AuthResult> {
  const name = email.split("@")[0] ?? email;
  return postAuth(
    "/api/auth/sign-up/email",
    { name, email, password },
    "creating your account",
  );
}

const SocialProviderId = type("'google' | 'github'");
export type SocialProviderId = typeof SocialProviderId.infer;

const AuthConfig = type({ socialProviders: SocialProviderId.array() });

export type AuthConfigResult =
  | { readonly kind: "ready"; readonly providers: readonly SocialProviderId[] }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * Asks the hub which OAuth providers a full credential pair was
 * configured for, so the sign-in screen only draws buttons for
 * providers that actually work. Distinguishes "the hub answered and
 * genuinely has none configured" (`ready` with an empty list) from a
 * network failure, a non-2xx response, or an unparseable body
 * (`unavailable`) — the auth screen still degrades to email/password
 * either way, but only the latter is worth telling the operator about.
 */
export async function fetchAuthConfig(): Promise<AuthConfigResult> {
  try {
    const response = await fetch("/api/auth-config", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return {
        kind: "unavailable",
        message: `The server answered ${response.status} for the auth config.`,
      };
    }
    const body: unknown = await response.json();
    const parsed = AuthConfig(body);
    if (parsed instanceof type.errors) {
      return {
        kind: "unavailable",
        message: `Unexpected auth config shape: ${parsed.summary}`,
      };
    }
    return { kind: "ready", providers: parsed.socialProviders };
  } catch (cause) {
    return {
      kind: "unavailable",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

const SocialSignInResponse = type({ url: "string" });

/**
 * Starts better-auth's OAuth redirect flow: better-auth's
 * sign-in/social endpoint does not itself redirect the browser — it
 * answers with the provider's authorization URL as JSON, and the
 * client is the one that navigates there. The provider then redirects
 * back to better-auth's own callback endpoint, which exchanges the
 * code, sets the session cookie, and only then redirects the browser
 * to `callbackURL` — so by the time this SPA reloads there, the normal
 * `fetchSession` probe on mount already finds a signed-in session with
 * no dedicated callback route needed on this side.
 */
export async function signInSocial(
  provider: SocialProviderId,
): Promise<AuthResult | null> {
  try {
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        callbackURL: window.location.origin,
      }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = FailureBody(payload);
      return {
        ok: false,
        message:
          failure instanceof type.errors
            ? `The server answered ${response.status} starting ${provider} sign-in.`
            : failure.message,
      };
    }
    const parsed = SocialSignInResponse(payload);
    if (parsed instanceof type.errors) {
      return {
        ok: false,
        message: `Unexpected response starting ${provider} sign-in: ${parsed.summary}`,
      };
    }
    window.location.assign(parsed.url);
    return null;
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}
