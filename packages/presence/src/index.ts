export {
  createPresenceRoomRegistry,
  PRESENCE_DOC_TEXT_FIELD,
  type PresenceRoomRegistry,
  type PresenceRoomKey,
  type PresenceRoomListener,
  type PresenceState,
  type PresenceStatePatch,
  type PresenceCursor,
  type PresenceDocUpdateListener,
  type PresenceDocSnapshotInfo,
  type PresenceDocSnapshotListener,
} from "./room-registry";

export { createPresenceRoutes, type CreatePresenceRoutesDeps } from "./routes";

export {
  PresenceJoinBody,
  PresenceHeartbeatBody,
  PresenceCursorSchema,
  PresenceDocUpdateBody,
  MAX_DOC_UPDATE_BYTES,
} from "./schema";

export {
  createArtifactDocPersistence,
  artifactIdForSurface,
  type ArtifactDocPersistence,
  type ArtifactDocPersistenceDeps,
} from "./artifact-persistence";

export { encodeBase64, decodeBase64, InvalidBase64Error } from "./base64";

// The browser client (`connectPresence`) is intentionally not re-exported
// here — it lives at the `./client` subpath (see package.json) so a
// server-side consumer of this package's "." export never pulls in
// browser-only globals (`fetch`, `EventSource`).
//
// `colorForPrincipal` is likewise only at the `./color` subpath: this "."
// export reaches `./routes`, and through it the whole `@intx/hub-api`
// server graph, so a browser package that wants nothing but the color
// function must not have to type-check a server through it.
