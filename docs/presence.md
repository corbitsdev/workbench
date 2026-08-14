# Presence

Presence is the multiplayer-visual substrate: who's here, where their
cursor is, whether they're typing — for a channel or a canvas artifact,
right now, with nothing kept once everyone leaves. `packages/presence`
(`@corbits/presence`) owns it end to end; `apps/hub` only mounts its routes,
and `apps/web` only composes its client into the channel header and the
canvas artifact pane. This document covers what phase 1 built and the seam
phase 2 (co-editing) builds on top of it.

## Rooms

A room is keyed by `(tenantId, surface)`, where `surface` is a free-form
string the caller owns — `channel:<id>` for a channel's who's-here stack,
`artifact:<id>` for a canvas artifact's co-viewer cursors. Two tenants can
never share a room even if they pick the identical `surface` string: the
tenant id is part of the key, not a namespace prefix a caller could get
wrong.

Rooms are in-process and ephemeral. `createPresenceRoomRegistry()`
(`packages/presence/src/room-registry.ts`) holds every live room in a
`Map`, keyed off `tenantId`/`surface`, and tears a room down the moment it
has no members and no SSE subscribers left — there is no persistence layer
to clean up, and a process restart simply loses presence, which is correct
for "who's here right now."

## Why Yjs, given the wire format is JSON

Each room keeps one `y-protocols` `Awareness` instance (backed by a
throwaway `Y.Doc`) as its state store, even though the HTTP contract
between browser and server is plain JSON, parsed with arktype
(`packages/presence/src/schema.ts`) — never a raw Yjs binary update. That's
deliberate: `Awareness` already gives every entry a clock and a
last-updated timestamp, and the registry's `join`/`heartbeat`/`leave` calls
write into it directly (see `writeAwarenessState` in `room-registry.ts`)
rather than requiring browsers to speak the binary awareness protocol
Yjs's own peer-to-peer providers use. Phase 1 needs none of Yjs's document
merge machinery — only its awareness bookkeeping — so the server is the
sole author of every client's state, and the JSON boundary stays exactly as
readable as `@corbits/chat`'s existing SSE payloads.

## The HTTP surface

Mounted by `apps/hub/src/index.ts` at `${TENANT_PREFIX}/presence`, inside
the hub's native tenant middleware — the same pattern `@corbits/chat`'s
routes use, and no new auth path: a handler always finds `c.get("tenant")`
and `c.get("principal")` already resolved.

- `POST /rooms/:surface/join` — join with an optional `displayName`,
  `cursor`, `typing`. The server assigns `principalId` (from the session)
  and `color` (deterministic, see below); a client can never claim someone
  else's identity or hand-pick a color.
- `POST /rooms/:surface/heartbeat` — keep-alive, with an optional
  `cursor`/`typing` patch on top of the existing state. `404` if the
  caller never joined (or was already dropped by a timeout) — the client's
  signal to rejoin, not a silent no-op.
- `POST /rooms/:surface/leave` — explicit leave.
- `GET /rooms/:surface/stream` — an SSE stream of `presence.state` events,
  each carrying the room's full member snapshot as JSON. Mirrors
  `@corbits/chat`'s `bridgeChannelStream`: a failed write unsubscribes
  immediately rather than waiting for `onAbort`.

There is no background sweep timer. Every join/heartbeat/leave call
opportunistically sweeps its own room for stale members first
(`registry.sweepStale`), so a client that goes quiet is caught within one
timeout window of the next request anyone makes to that room — the
heartbeat protocol itself guarantees that traffic exists.

## Deterministic color

`colorForPrincipal` (`packages/presence/src/color.ts`) hashes a principal
id to an HSL hue, nudging it away from the brand's orange accent band so a
presence dot never reads as chrome. Pure function, no storage: every
process computes the same color for the same principal without
coordination.

## The browser client

`@corbits/presence/client` (`packages/presence/src/client.ts`) is the one
browser-safe module in the package: no React dependency, a plain
subscribe/callback API (`connectPresence`), fetch/EventSource
dependency-injectable for testing. `apps/web/src/presence/use-presence-room.ts`
is the thin React hook that wraps it — the only place apps/web talks to the
presence package directly. Two composition sites use it today:

- `apps/web/src/pages/chat-page.tsx` connects to `channel:<channelId>` and
  hands the snapshot to `@corbits/chat-ui`'s `ChatWorkspace` as
  `presenceMembers`, rendered as a live avatar stack beside the channel
  header's static participant list.
- `apps/web/src/shell/app-shell.tsx` connects to `artifact:<artifactId>`
  when the canvas has one open, publishes the pointer's fractional position
  over the artifact pane as `cursor`, and hands the room's snapshot to
  `CanvasColumn` as `presenceCursors` — colored, labeled dots overlaid on
  the read-only artifact renderer.

Neither `@corbits/chat-ui` nor `apps/web/src/shell/canvas-column.tsx`
imports `@corbits/presence` itself — both only take plain data
(`PresenceMember`, `PresenceCursor`) as props, the same way they take any
other host-supplied data.

## Phase 2: co-editing

Phase 1 deliberately stops at awareness — no shared document content, no
version history. The seam is already in place: each room's `Y.Doc`
(`room-registry.ts`) exists today only to back its `Awareness` instance,
but it is a real, empty Yjs document sitting right there. Phase 2 adds
actual content to it:

- The room's `Y.Doc` starts carrying the artifact's editable content
  (a `Y.Text` or `Y.XmlFragment`, depending on the renderer), synced the
  same way awareness already is — updates broadcast over the existing SSE
  stream, applied client-side with the same `y-protocols`/`yjs` APIs this
  package already depends on.
- A cursor's `surfaceVersion` field, present in the awareness payload since
  phase 1 but unused until now, becomes the anchor a co-editing cursor
  needs to stay attached to the right position after a concurrent edit
  reflows the document.
- Persistence — periodic snapshots of the `Y.Doc` into an artifact version
  row — is new work; phase 1's registry never persists anything and phase
  2 should not change that default for presence itself, only add a
  snapshot path for the document content layered on top.
- Tenant isolation, the join/leave/heartbeat HTTP surface, and the color
  assignment scheme all carry over unchanged — phase 2 is additive to this
  substrate, not a replacement for it.
