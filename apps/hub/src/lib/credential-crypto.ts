import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireCredentialEncryptionKey } from "../config";

// Generic AES-256-GCM envelope for credential secrets at rest (CL-3446,
// extracted from the OAuth-token-only helper CL-3356/#832 introduced in
// oauth-crypto.ts). Both the OAuth token store (principal-owned
// `oauth_token` credentials) and the owner-set tool-credential store
// (`kind: "tool"` rows — API keys, OAuth app client secrets) share this one
// envelope format so there is exactly one encrypt/decrypt implementation and
// one place that recognizes a `v1:` envelope.
//
// `kind: "inference"` credential rows stay plaintext-compatible: Interchange
// reads `credential.secret` raw at agent-launch time
// (interchange/packages/db/src/model-source-resolution.ts) and cannot be
// modified to decrypt first.
//
// Envelope wire format (single column string): `v1:<ivB64>:<tagB64>:<ctB64>`.
// The `v1:` tag makes the scheme upgradeable and lets a reader detect a value
// that was never encrypted (e.g. a legacy plaintext row) and fail loudly
// rather than return garbage.

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

// A positive check that a value handed to a downstream consumer is genuine
// plaintext, never a still-encrypted envelope (CL-3446 hardening note: a
// future miswiring must fail loudly rather than forward ciphertext as if it
// were a usable API key / token).
function assertPlaintext(value: string, context: string): string {
  if (isEncryptedEnvelope(value)) {
    throw new Error(
      `credential-crypto: refusing to forward an encrypted envelope as plaintext (${context})`,
    );
  }
  return value;
}

// The single decrypting-resolver read sites call for a credential `secret`
// (or `refreshSecret`) column value they are about to hand to a tool/adapter
// as an API key or token. Detects the `v1:` envelope and decrypts it; a
// legacy or inference-kind plaintext value passes through unchanged. Every
// hub read site that resolves a credential for tool execution — never the
// Interchange agent-launch path, which reads the column raw — MUST go
// through this rather than reading `.secret` directly, so there is exactly
// one place that knows the envelope and can never forward it undecrypted.
export function decryptToolCredentialSecret(value: string): string {
  const plaintext = isEncryptedEnvelope(value) ? decryptSecret(value) : value;
  return assertPlaintext(plaintext, "decryptToolCredentialSecret");
}
