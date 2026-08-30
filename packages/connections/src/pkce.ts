// The RFC 7636 PKCE mechanics and the single-use state store shared by
// every OAuth connect flow this package offers (OpenRouter and Hugging
// Face through `./oauth-routes.ts`, the MCP-server connect through
// `./mcp-oauth-routes.ts`): a verifier/S256-challenge pair, and a
// short-TTL state that keys a caller-shaped payload to the signed-in
// user who started the flow. Each connect module owns its own TTL,
// payload schema, and endpoints — only the cryptographic and
// bookkeeping primitives live here, so a third connect flow never
// re-derives them.
//
// The state itself carries no server-side bookkeeping: `issue` seals
// `{ userId, nonce, expiresAt, payload }` into a single
// AEAD-encrypted token through the caller's `CredentialCipher` (the same
// seam `CREDENTIAL_ENCRYPTION_KEY` backs everywhere else a secret is
// encrypted at rest — see `apps/hub`'s `credentialCipherFrom`) and hands
// that token back as the "state". `consume` decrypts it, never a map
// lookup, so a state minted moments before a hub restart (dev watch
// reload, a deploy) is exactly as redeemable after the restart as
// before it — the payload survives in the client's cookie, not in this
// process's memory. A per-store, in-memory set of already-consumed
// nonces still blocks a replay within one process's uptime (the normal
// case: a browser presents the same state cookie twice). It resets on
// restart, but that residual window is bounded by the same things that
// already bounded it before this change: the provider's own
// authorization `code` is itself single-use, and the state's short TTL
// plus session binding.
import { type } from "arktype";
import type { CredentialCipher } from "@intx/types";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** 43 base64url chars from 32 random bytes — the entropy grade shared
 * by PKCE verifiers, state-envelope nonces, and the OAuth `state`
 * values connect flows send to an authorization server. */
export function randomToken(): string {
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

const ConnectStateEnvelope = type({
  userId: "string > 0",
  nonce: "string > 0",
  expiresAt: "number",
  payload: "unknown",
});

/** Binds a sealed state to the one connect flow it was minted for, so a
 * state minted for OpenRouter's callback cannot decrypt at Hugging
 * Face's (or a future provider's) — domain separation on top of the
 * AEAD tag, not instead of it. */
function connectStateAad(provider: string): string {
  return JSON.stringify(["onboarding-connect-state", provider]);
}

export type ConnectStateStore<Payload> = {
  issue(args: { userId: string; payload: Payload }): Promise<string>;
  /** Returns the payload exactly once; a second consume, a wrong user,
   * an expired state, a state sealed for a different provider, or a
   * payload `parsePayload` refuses all come back undefined. */
  consume(args: {
    state: string;
    userId: string;
  }): Promise<Payload | undefined>;
};

export function createConnectStateStore<Payload>(args: {
  cipher: CredentialCipher;
  provider: string;
  /** Trust-boundary parse of the decrypted payload — the envelope's
   * user/nonce/expiry bookkeeping is validated here, but the payload's
   * shape is the connect flow's own contract. Return undefined to
   * reject. */
  parsePayload: (value: unknown) => Payload | undefined;
  ttlMs?: number;
  now?: () => number;
}): ConnectStateStore<Payload> {
  const { cipher, provider, parsePayload } = args;
  const ttlMs = args.ttlMs ?? 10 * 60 * 1000;
  const now = args.now ?? Date.now;
  const aad = connectStateAad(provider);

  // Same-process replay guard (see module comment for why this doesn't
  // need to survive a restart). Swept by the nonce's own `expiresAt`,
  // so it never grows past the TTL window's worth of consumed states.
  const consumedNonces = new Map<string, number>();
  function sweep(): void {
    const cutoff = now();
    for (const [nonce, expiresAt] of consumedNonces) {
      if (expiresAt <= cutoff) consumedNonces.delete(nonce);
    }
  }

  return {
    async issue({ userId, payload }) {
      const envelope = {
        userId,
        nonce: randomToken(),
        expiresAt: now() + ttlMs,
        payload,
      };
      return cipher.encrypt(JSON.stringify(envelope), aad);
    },

    async consume({ state, userId }) {
      sweep();

      let envelope: typeof ConnectStateEnvelope.infer;
      try {
        const plaintext = await cipher.decrypt(state, aad);
        const parsed = ConnectStateEnvelope(JSON.parse(plaintext));
        if (parsed instanceof type.errors) return undefined;
        envelope = parsed;
      } catch {
        // report-error-ignore: CL-7247 — decrypt/parse failure here is the
        // expected outcome for a tampered, expired-then-reused, or wrong-
        // provider state, indistinguishable from malicious probing by
        // design (see module header). Reporting it would create a
        // decrypt-failure oracle and flood the sink with routine,
        // non-actionable noise.
        return undefined;
      }

      if (envelope.expiresAt <= now()) return undefined;

      // Consumed by the attempt regardless of outcome — a wrong-user
      // redeem burns the state exactly like the rightful user's would,
      // so a stolen state cookie is worthless to everyone after one try.
      if (consumedNonces.has(envelope.nonce)) return undefined;
      consumedNonces.set(envelope.nonce, envelope.expiresAt);

      if (envelope.userId !== userId) return undefined;
      return parsePayload(envelope.payload);
    },
  };
}
