# @corbits/presence

Ephemeral multiplayer presence: awareness rooms (who's here, cursors,
typing) for a `(tenantId, surface)` pair, carried on the hub's own SSE
transport. Nothing here persists by default — a process restart simply
loses presence, the correct behavior for "who's here right now" — except
for one opt-in layer that snapshots Yjs-doc content into a Library
artifact.

## Composition

- `room-registry.ts` backs each room with one `y-protocols` `Awareness`
  instance over a `yjs` `Y.Doc`. The wire format between browser and
  server is plain JSON (never raw Yjs binary), but the registry
  deliberately speaks Yjs internally so a later co-editing phase (real
  shared `Y.Doc` content, not just awareness) is additive rather than a
  rewrite — see `docs/presence.md`.
  - `routes.ts` mounts inside the hub's own tenant-scoped middleware
    (`apps/hub/src/index.ts`), so `@intx/hub-api`'s `TenantEnv`
    (`tenant`/`principal`) is always resolved before a handler runs — no
    new auth path, no client-supplied `principalId` (see `schema.ts`).
  - `color.ts`'s `colorForPrincipal` is a pure function of `principalId`
    with no server-side storage, computed identically wherever it's
    needed, nudged away from the brand's orange accent hue.
  - `artifact-persistence.ts` layers debounced Yjs-doc → artifact-version
    persistence on top of the registry without changing its ephemeral
    default; every real-storage dependency is injected (mirrors
    `@corbits/artifacts-hub`'s `ArtifactRoutesStore` DI shape), so this
    package never imports `@corbits/artifacts` directly.
- The browser client (`connectPresence`) lives at the `./client` subpath,
  not the package root, so a server-side consumer of `.` never pulls in
  browser-only globals (`fetch`, `EventSource`).

## Key modules

- `room-registry.ts` — `createPresenceRoomRegistry`: join/heartbeat/leave,
  state patches, doc update broadcast.
- `routes.ts` — `createPresenceRoutes`: join/heartbeat/leave POSTs plus an
  SSE stream of a room's live awareness snapshot.
- `client.ts` (`./client` subpath) — `connectPresence`: dependency-injectable
  `fetch`/`EventSource`, unit-testable with fakes.
- `artifact-persistence.ts` — `createArtifactDocPersistence`,
  `artifactIdForSurface`: the `artifact:<id>` surface convention mapping a
  room's `Y.Text` to a Library artifact's content.
- `color.ts` — `colorForPrincipal`: deterministic, storage-free per-principal
  color.
- `base64.ts` — hand-written base64 codec shared by server and browser
  (neither `Buffer` nor `btoa`/`atob` is guaranteed on both).

## Tests

```
cd packages/presence && bun test
```

No DATABASE_URL needed — presence is in-process/ephemeral; the persistence
layer's storage dependencies are injected fakes in tests.
