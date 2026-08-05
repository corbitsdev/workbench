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
        message: `The hub answered ${response.status} for the session check.`,
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
            ? `The hub answered ${response.status} for ${path}.`
            : failure.message,
      };
    }
    const parsed = SessionPayload(payload);
    if (parsed instanceof type.errors) {
      return {
        ok: false,
        message: `Unexpected response shape from ${path}: ${parsed.summary}`,
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

export async function signOut(): Promise<void> {
  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}
