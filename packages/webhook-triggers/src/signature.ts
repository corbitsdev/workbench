// The trust boundary this package exists to guard: an inbound HTTP
// call from a network Workbench does not control. Every byte off the
// wire is untrusted until its signature verifies against the
// trigger's own secret.
//
// Security-model note (v1, deliberate, not a hack): the secret is
// generated server-side with `crypto.randomBytes` and shown to the
// caller exactly once, at creation or rotation — but it is then
// stored in plaintext in `webhook_trigger.secret` so this module can
// recompute the same HMAC to verify later deliveries. That is
// acceptable for v1 (mirrors how most webhook providers, e.g.
// Stripe/GitHub, keep the verifying side able to recompute the MAC)
// but it does mean a database compromise discloses every trigger's
// signing secret. A hash-only-at-rest design (verify by recomputing
// against a caller-supplied secret you never store) does not fit HMAC
// verification, which needs the raw secret on the verifying side;
// closing this gap for real means either an HSM/KMS-backed secret
// store or moving to asymmetric signing (caller signs with a private
// key, this package verifies with a stored public key) — both platform
// capabilities, not something to bolt on here. Flagged, not silently
// accepted.
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
