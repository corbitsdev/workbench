// The trust boundary this package exists to guard: an inbound HTTP
// call from a network Workbench does not control. Every byte off the
// wire is untrusted until its signature verifies against the
// trigger's own secret.
//
// Security-model note: the secret is generated server-side with
// `crypto.randomBytes` and shown to the caller exactly once, at
// creation or rotation. `store.ts` now encrypts it at rest through
// Interchange's `CredentialCipher` seam (`@intx/types`), closing the
// "database dump discloses every signing secret" half of this
// tradeoff — but this function still needs the *raw* secret in process
// memory to recompute the HMAC, and `store.ts` decrypts it back to
// plaintext for exactly that purpose on every `get`/`getById`. That
// half of the tradeoff is inherent to HMAC verification (unlike a
// hashed password, the verifying side must be able to reproduce the
// MAC, not just compare against it) and is not something
// `CredentialCipher` — an at-rest seam — removes; closing it for real
// means moving to asymmetric signing (caller signs with a private key,
// this package verifies with a stored public key), a bigger v2 change.
// Flagged, not silently accepted.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

const SECRET_BYTES = 32;

/** A fresh, high-entropy secret for a new or rotated trigger. */
export function generateWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

/** The HMAC-SHA256 hex digest of `rawBody` under `secret`. */
export function signPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Verifies an inbound `X-Webhook-Signature` header against the
 * trigger's stored secret, in constant time so a timing side-channel
 * never leaks how many leading bytes of a guess were correct.
 * `timingSafeEqual` throws on a length mismatch rather than returning
 * false, so an obviously-wrong-length header is rejected explicitly
 * before comparison, not left to throw past this function.
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  providedSignatureHex: string | undefined,
): boolean {
  if (providedSignatureHex === undefined || providedSignatureHex === "") {
    return false;
  }
  const expected = signPayload(secret, rawBody);
  const expectedBuffer = Buffer.from(expected, "hex");
  let providedBuffer: Buffer;
  try {
    providedBuffer = Buffer.from(providedSignatureHex, "hex");
  } catch {
    return false;
  }
  if (
    expectedBuffer.length !== providedBuffer.length ||
    expectedBuffer.length === 0
  ) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}
