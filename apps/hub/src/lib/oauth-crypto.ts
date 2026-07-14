import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";

// Workbench-local envelope encryption for OAuth token secrets (CL-3356 pillar
// B / O3). Interchange stores credential `secret`/`refreshSecret` as PLAINTEXT
// (its own admission — see interchange/docs/CREDENTIALS.md "Encryption at
// rest"). We own the OAuth callback insert and the resolver read, so we wrap the
// secret column VALUES in AES-256-GCM rather than reimplementing the
// credential model. A DB leak without the KMS key then exposes only ciphertext.
//
// The envelope implementation itself (`encryptSecret`/`decryptSecret`/
// `isEncryptedEnvelope`) moved to `./credential-crypto` in CL-3446 so the
// owner-set tool-credential store (`kind: "tool"` rows) shares the exact same
// AES-256-GCM envelope rather than a second implementation. Re-exported here
// so existing OAuth-flow imports keep working unchanged.
export {
  encryptSecret,
  decryptSecret,
  isEncryptedEnvelope,
} from "./credential-crypto";

// ─── Signed OAuth `state` (CSRF + principal binding) ───────────────
//
// The authorize `state` is an HMAC-signed, base64url JSON payload binding the
// member principal, tenant, provider, and a random nonce. The nonce is the key
// into the server-side PKCE-verifier store; the signature makes the state
// tamper-proof and non-forgeable so the callback can trust the principal it
// carries without a session (a browser top-level redirect may not carry the
// session cookie cross-site).

export const OAuthStatePayloadSchema = type({
  nonce: "string",
  provider: "string",
  tenantId: "string",
  memberPrincipalId: "string",
  issuedAt: "number",
});
export type OAuthStatePayload = typeof OAuthStatePayloadSchema.infer;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signState(payload: OAuthStatePayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyState(
  token: string,
  secret: string,
): OAuthStatePayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // Parse, not cast: a signature-valid but malformed payload is rejected.
  const parsed = OAuthStatePayloadSchema(json);
  if (parsed instanceof type.errors) return null;
  return parsed;
}
