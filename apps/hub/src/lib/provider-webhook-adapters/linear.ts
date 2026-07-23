import { createHmac, timingSafeEqual } from "node:crypto";
import { type } from "arktype";
import type { ProviderWebhookAdapter } from "../provider-webhooks";

// Linear's own recommendation: reject a delivery whose `webhookTimestamp` is
// more than a minute from the time we see it (replay protection).
const REPLAY_TOLERANCE_MS = 60_000;

// Minimal envelope every Linear webhook delivery carries. `data` is
// intentionally untyped (`unknown`) -- this adapter's job is authenticating
// and routing the delivery, not interpreting every entity payload shape.
const LinearWebhookEnvelope = type({
  action: "string",
  type: "string",
  organizationId: "string",
  webhookId: "string",
  webhookTimestamp: "number",
  "data?": "unknown",
});

/** Constant-time compare of two hex-encoded HMAC digests. Any length/format
 * mismatch is a non-match rather than a throw. */
function signatureMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Linear's provider-webhook adapter (CL-4269). Registered with the generic
 * `createProviderWebhookRouter` -- this module owns none of the shared
 * receive logic (body reading, size limits, dedupe storage, dispatch), only
 * what is genuinely Linear-specific:
 *
 * - Signature: hex-encoded HMAC-SHA256 of the RAW body, header
 *   `Linear-Signature`.
 * - Replay window: `webhookTimestamp` (Unix ms) in the payload, ~1 minute
 *   tolerance.
 * - Idempotency key: header `Linear-Delivery` (a UUID Linear reuses across
 *   its up-to-3 retries of one logical event).
 * - Tenant key: `organizationId` in the payload -- an app-level Linear
 *   webhook is ONE URL shared by every authorizing workspace, so this is
 *   how a delivery says which workspace it is from.
 * - Secret: resolved via the generic `<provider>-webhook` credential
 *   convention, i.e. the `linear-webhook` tool credential set from Owner ->
 *   Capabilities.
 */
export const linearWebhookAdapter: ProviderWebhookAdapter = {
  provider: "linear",
  signatureHeader: "linear-signature",
  deliveryIdHeader: "linear-delivery",
  replayToleranceMs: REPLAY_TOLERANCE_MS,
  tenantKeyMetadataField: "organizationId",

  parsePayload(rawBody: string): unknown | null {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const envelope = LinearWebhookEnvelope(payload);
    if (envelope instanceof type.errors) return null;
    return envelope;
  },

  verifySignature({ rawBody, signatureHeaderValue, secret }): boolean {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return signatureMatches(expected, signatureHeaderValue);
  },

  extractTenantKey(payload: unknown): string | null {
    const envelope = LinearWebhookEnvelope(payload);
    return envelope instanceof type.errors ? null : envelope.organizationId;
  },

  extractTimestampMs(payload: unknown): number | null {
    const envelope = LinearWebhookEnvelope(payload);
    return envelope instanceof type.errors ? null : envelope.webhookTimestamp;
  },

  extractDeliveryMeta(payload: unknown) {
    const envelope = LinearWebhookEnvelope(payload);
    if (envelope instanceof type.errors) return null;
    return {
      action: envelope.action,
      entityType: envelope.type,
      webhookId: envelope.webhookId,
      data: envelope.data,
    };
  },
};
