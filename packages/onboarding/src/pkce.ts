// The RFC 7636 PKCE mechanics and the single-use state store shared by
// every OAuth connect flow this package offers (OpenRouter today,
// Hugging Face alongside it): a verifier/S256-challenge pair, and a
// short-TTL state that keys the server-held verifier to the signed-in
// user who started the flow. Each connect module owns its own TTL and
// endpoints — only the cryptographic and bookkeeping primitives live
// here, so a third connect flow never re-derives them.

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
  const ttlMs = args?.ttlMs ?? 10 * 60 * 1000;
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
