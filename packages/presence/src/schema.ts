// Inbound request bodies, parsed at the boundary — never trusted as `as T`.
// `principalId` and `color` are deliberately absent from every inbound
// schema: identity always comes from `c.get("principal")` (the tenant
// middleware already resolved it), and color is always server-assigned
// (see `./color.ts`) so no client can spoof another principal's identity
// or hand-pick a color that collides with someone else's.
import { type } from "arktype";

export const PresenceCursorSchema = type({
  x: "number",
  y: "number",
  surfaceVersion: "number",
});

export const PresenceJoinBody = type({
  "displayName?": "string",
  "cursor?": PresenceCursorSchema,
  "typing?": "boolean",
});

export const PresenceHeartbeatBody = type({
  "cursor?": PresenceCursorSchema,
  "typing?": "boolean",
});

/**
 * A Yjs doc update, base64-encoded — arktype only checks it's a string
 * here; decoding and the byte-size cap happen in the route handler, where
 * a bad-base64 payload and an oversize payload get distinct error codes
 * (400 vs 413) rather than folding both into one generic validation
 * failure.
 */
export const PresenceDocUpdateBody = type({
  update: "string",
});

/**
 * Decoded-byte ceiling for a single doc update POST. Sized to comfortably
 * cover a large paste (tens of KB of text encodes to a Yjs update a small
 * multiple of that) while still refusing the megabyte-scale payloads a
 * buggy or hostile client might send — "reject megabyte updates honestly"
 * rather than let them through and let the server run to eventually
 * time out or run OOM.
 */
export const MAX_DOC_UPDATE_BYTES = 256 * 1024;

/**
 * The largest base64 string that could possibly decode to `byteLimit`
 * bytes or fewer — `4 * ceil(byteLimit / 3)`, the standard base64
 * expansion ratio (3 bytes → 4 characters, rounded up to a full group
 * with padding). The route handler checks the raw STRING length against
 * this bound before ever calling `decodeBase64`, so a hostile
 * multi-megabyte string is rejected by a cheap `.length` check rather
 * than first being materialized into a decoded `Uint8Array` (the decode
 * itself allocates and loops over the whole input) only to be thrown away
 * once the byte-length check downstream finally catches it.
 */
export function maxBase64LengthFor(byteLimit: number): number {
  return Math.ceil(byteLimit / 3) * 4;
}
