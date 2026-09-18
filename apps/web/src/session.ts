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

// better-auth answers 200 with a JSON `null` body when there's no
// session, so "signed out" is normal here, never a 401 in the log.
export async function fetchSession(): Promise<SessionState> {
  try {
    const response = await fetch("/api/auth/get-session", {
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return { kind: "signed-out" };
    if (!response.ok) {
      return {
        kind: "error",
        message: "We couldn't reach Workbench just now. Try again in a moment.",
      };
    }
    const body: unknown = await response.json();
    if (body === null) return { kind: "signed-out" };
    const parsed = SessionPayload(body);
    // An unrecognizable payload means "no session" (restarted hub, dead
    // cookie), not a connectivity failure — routes to login, not "offline".
    if (parsed instanceof type.errors) return { kind: "signed-out" };
    return { kind: "signed-in", user: parsed.user };
  } catch {
    return {
      kind: "error",
      message: "You're offline, or Workbench isn't reachable. We'll keep trying.",
    };
  }
}

export type AuthResult =
  | { readonly ok: true; readonly user: SessionUser }
  | { readonly ok: false; readonly message: string };

const FailureBody = type({ message: "string" });

// Shared so sign-in, sign-up, and social sign-in all tell the person when
// it's worth retrying, instead of surfacing better-auth's generic body.
function rateLimitedResult(response: Response): AuthResult {
  const retryAfterSeconds = Number(response.headers.get("x-retry-after"));
  return {
    ok: false,
    message:
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? `Too many sign-in attempts. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}.`
        : "Too many sign-in attempts. Please wait a moment and try again.",
  };
}

async function postAuth(path: string, body: Record<string, string>): Promise<AuthResult> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status === 429) return rateLimitedResult(response);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = FailureBody(payload);
      return {
        ok: false,
        message:
          failure instanceof type.errors
            ? "Something went wrong signing you in. Try again."
            : failure.message,
      };
    }
    const parsed = SessionPayload(payload);
    if (parsed instanceof type.errors) {
      return {
        ok: false,
        message: "Something went wrong signing you in. Try again.",
      };
    }
    return { ok: true, user: parsed.user };
  } catch {
    return {
      ok: false,
      message: "Something went wrong signing you in. Try again.",
    };
  }
}

export function signIn(email: string, password: string): Promise<AuthResult> {
  return postAuth("/api/auth/sign-in/email", { email, password });
}

// better-auth requires a display name; starts as the address's local part
// until the hub grows a profile editor.
export function signUp(email: string, password: string): Promise<AuthResult> {
  const name = email.split("@")[0] ?? email;
  return postAuth("/api/auth/sign-up/email", { name, email, password });
}

const SocialProviderId = type("'google' | 'github'");
export type SocialProviderId = typeof SocialProviderId.infer;

// Stock Interchange exposes no sign-in discovery endpoint, so the client
// drives this list — an unconfigured click surfaces better-auth's own
// error on the form.
export const SOCIAL_SIGN_IN_PROVIDERS: readonly SocialProviderId[] = ["google", "github"];

const SocialSignInResponse = type({ url: "string" });

// better-auth's endpoint answers with the authorization URL as JSON
// rather than redirecting itself; by the time the SPA reloads at
// `callbackURL`, `fetchSession` on mount already finds a signed-in session.
export async function signInSocial(provider: SocialProviderId): Promise<AuthResult | null> {
  try {
    const response = await fetch("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider,
        callbackURL: window.location.origin,
      }),
    });
    if (response.status === 429) return rateLimitedResult(response);
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = FailureBody(payload);
      return {
        ok: false,
        message:
          failure instanceof type.errors
            ? "Something went wrong signing you in. Try again."
            : failure.message,
      };
    }
    const parsed = SocialSignInResponse(payload);
    if (parsed instanceof type.errors) {
      return {
        ok: false,
        message: "Something went wrong signing you in. Try again.",
      };
    }
    window.location.assign(parsed.url);
    return null;
  } catch {
    return {
      ok: false,
      message: "Something went wrong signing you in. Try again.",
    };
  }
}

// The UI signs out optimistically regardless of outcome; the boolean
// lets the caller surface a failure instead of leaving a live session.
export async function signOut(): Promise<boolean> {
  return fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
    .then((response) => response.ok)
    .catch(() => false);
}
