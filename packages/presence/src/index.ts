export {
  createPresenceRoomRegistry,
  type PresenceRoomRegistry,
  type PresenceRoomKey,
  type PresenceRoomListener,
  type PresenceState,
  type PresenceStatePatch,
  type PresenceCursor,
} from "./room-registry";

export { colorForPrincipal } from "./color";

export { createPresenceRoutes, type CreatePresenceRoutesDeps } from "./routes";

export {
  PresenceJoinBody,
  PresenceHeartbeatBody,
  PresenceCursorSchema,
} from "./schema";

// The browser client (`connectPresence`) is intentionally not re-exported
// here — it lives at the `./client` subpath (see package.json) so a
// server-side consumer of this package's "." export never pulls in
// browser-only globals (`fetch`, `EventSource`).
