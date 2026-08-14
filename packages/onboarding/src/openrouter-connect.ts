// The mechanics of OpenRouter's registration-free PKCE connect
// (openrouter.ai/docs — OAuth PKCE): a verifier/S256-challenge pair,
// the single-use short-TTL state that keys the server-held verifier,
// and the code-for-key exchange. OpenRouter's flow returns a durable
// user-scoped API key — not an expiring token — so everything after the
// exchange is the ordinary api_key credential path. The key itself is
// never logged and never put in a URL.

import { type } from "arktype";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_URL =
  "https://openrouter.ai/api/v1/auth/keys";

/** OpenRouter authorization codes expire in 10 minutes; a pending
 * connect is worthless after that, so its state is too. */
export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export type PKCEPair = {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
};

/** A fresh verifier and its S256 challenge, both base64url per RFC 7636. */
export async function generatePKCEPair(): Promise<PKCEPair> {
  const codeVerifier = randomToken();
  return { codeVerifier, codeChallenge: await s256Challenge(codeVerifier) };
}

export async function s256Challenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64url(new Uint8Array(digest));
}

export type ConnectStateStore = {
  issue(args: { userId: string; codeVerifier: string }): string;
  /** Returns the verifier exactly once; a second consume, a wrong user,
   * or an expired state all come back undefined. */
  consume(args: { state: string; userId: string }): string | undefined;
};

export function createConnectStateStore(args?: {
  ttlMs?: number;
  now?: () => number;
}): ConnectStateStore {
  const ttlMs = args?.ttlMs ?? CONNECT_STATE_TTL_MS;
  const now = args?.now ?? Date.now;
  const pending = new Map<
    string,
    { userId: string; codeVerifier: string; expiresAt: number }
  >();

  function sweep(): void {
    const cutoff = now();
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= cutoff) pending.delete(state);
    }
  }

  return {
    issue({ userId, codeVerifier }) {
      sweep();
      const state = randomToken();
      pending.set(state, { userId, codeVerifier, expiresAt: now() + ttlMs });
      return state;
    },
    consume({ state, userId }) {
      sweep();
      const entry = pending.get(state);
      if (entry === undefined) return undefined;
      pending.delete(state);
      if (entry.userId !== userId) return undefined;
      return entry.codeVerifier;
    },
  };
}

const KeyExchangeResponse = type({ key: "string > 0" });

export type ExchangeResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly message: string };

export type ExchangeFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  },
) => Promise<Response>;

export type ExchangeCodeForKeyArgs = {
  readonly code: string;
  readonly codeVerifier: string;
  readonly fetchImpl?: ExchangeFetch;
};

/**
 * Trades an authorization code and its verifier for the user-scoped
 * OpenRouter API key. Failure messages describe the exchange, never
 * the key — there is no path on which key material reaches a log line
 * or an error string.
 */
export async function exchangeCodeForKey(
  args: ExchangeCodeForKeyArgs,
): Promise<ExchangeResult> {
  const doFetch = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(OPENROUTER_KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: args.code,
        code_verifier: args.codeVerifier,
        code_challenge_method: "S256",
      }),
    });
  } catch (cause) {
    return {
      ok: false,
      message:
        cause instanceof Error
          ? `Could not reach OpenRouter: ${cause.message}`
          : `Could not reach OpenRouter: ${String(cause)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `OpenRouter rejected the code exchange with status ${response.status}`,
    };
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = KeyExchangeResponse(body);
  if (parsed instanceof type.errors) {
    return {
      ok: false,
      message: "OpenRouter's exchange response did not carry a key",
    };
  }
  return { ok: true, key: parsed.key };
}
