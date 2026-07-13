import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { type } from "arktype";
import { requireCredentialEncryptionKey } from "../config";

// Workbench-local envelope encryption for OAuth token secrets (CL-3356 pillar
// B / O3). Interchange stores credential `secret`/`refreshSecret` as PLAINTEXT
// (its own admission — see interchange/docs/CREDENTIALS.md "Encryption at
// rest"). We own the OAuth callback insert and the resolver read, so we wrap the
// secret column VALUES in AES-256-GCM here rather than reimplementing the
// credential model. A DB leak without the KMS key then exposes only ciphertext.
//
// Envelope wire format (single column string): `v1:<ivB64>:<tagB64>:<ctB64>`.
// The `v1:` tag makes the scheme upgradeable and lets a reader detect a value
// that was never encrypted (e.g. a legacy plaintext row) and fail loudly rather
// than return garbage.

const ENVELOPE_PREFIX = "v1";
const IV_BYTES = 12;

export function encryptSecret(plaintext: string): string {
  const key = requireCredentialEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    ENVELOPE_PREFIX,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function isEncryptedEnvelope(value: string): boolean {
  return value.startsWith(`${ENVELOPE_PREFIX}:`);
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(":");
  const [prefix, ivB64, tagB64, ctB64] = parts;
  if (
    parts.length !== 4 ||
    prefix !== ENVELOPE_PREFIX ||
    ivB64 === undefined ||
    tagB64 === undefined ||
    ctB64 === undefined
  ) {
    throw new Error(
      "decryptSecret: value is not a v1 encryption envelope (refusing to return unverified plaintext)",
    );
  }
  const key = requireCredentialEncryptionKey();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

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
