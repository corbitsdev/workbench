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
