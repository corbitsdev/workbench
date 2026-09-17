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
        message: "We couldn't reach Workbench just now. Try again in a moment.",
      };
    }
    const body: unknown = await response.json();
    if (body === null) return { kind: "signed-out" };
    const parsed = SessionPayload(body);
    // A session payload that parses but is missing its user (or is
    // shaped unrecognizably) means the hub answered without a session
    // this app can use — a restarted hub on an empty DB, or a cookie for
    // a user that no longer exists. That is "no session", not a genuine
    // connectivity failure: it routes to the login screen exactly like a
    // 401 or a `null` body, never to the "connection lost" error state.
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

/**
 * better-auth answers a rate-limited request with a bare 429 and an
 * `X-Retry-After` header (seconds). Every auth entry point in this file
 * shares this so sign-in, sign-up, and social sign-in all tell the person
 * what happened and when it's worth trying again, instead of surfacing
 * better-auth's generic "Too many requests" body.
 */
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

/**
 * Creates the account. better-auth requires a display name; like the CLI's
 * admin bootstrap, it starts as the address's local part until the hub grows
 * a profile editor.
 */
export function signUp(email: string, password: string): Promise<AuthResult> {
  const name = email.split("@")[0] ?? email;
  return postAuth("/api/auth/sign-up/email", { name, email, password });
}

const SocialProviderId = type("'google' | 'github'");
export type SocialProviderId = typeof SocialProviderId.infer;

/**
 * Client config for the sign-in screen's OAuth buttons: the providers
 * this client knows how to draw. Stock Interchange exposes no sign-in
 * discovery endpoint, so the client drives — there is intentionally no
 * fetch here. The hub still decides which of these actually work:
 * better-auth only wires the credential pairs it was given, so an
 * unconfigured click surfaces better-auth's own error on the form.
 */
export const SOCIAL_SIGN_IN_PROVIDERS: readonly SocialProviderId[] = ["google", "github"];

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

/** Fires the server-side sign-out. The UI signs out optimistically
 * regardless of this call's outcome (see `main.tsx`'s `handleSignOut`) —
 * returns whether the server actually cleared the session, so the caller
 * can surface a failure rather than silently leaving a live session
 * behind on the server. */
export async function signOut(): Promise<boolean> {
  return fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })
    .then((response) => response.ok)
    .catch(() => false);
}
