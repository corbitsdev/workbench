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

Phase 1 stopped at awareness — no shared document content, no version
history. Phase 2 adds real convergent editing on top of the same rooms,
without changing anything phase 1 already shipped: tenant isolation, the
join/leave/heartbeat surface, and the color assignment scheme all carry
over unchanged.

### Doc sync

Each room's `Y.Doc` (`room-registry.ts`) — which phase 1 only ever used to
back its `Awareness` instance — now carries real content in a
`Y.Text` field named `content`. The registry adds:

- `applyDocUpdate(key, update, authorPrincipalId)` — applies a decoded Yjs
  update to the room's doc and fans it out to that room's SSE subscribers
  and to a registry-wide `onDocChange` hook (persistence's trigger).
- `docStateAsUpdate(key)` — the room's full doc state encoded as one Yjs
  update, for a new joiner to catch up.
- `seedDocText`/`docText` — seeding and reading the `Y.Text` content
  directly, used by persistence's join-time seed and snapshot read.
- `onEmpty`/`notifySnapshot`/`subscribeSnapshots` — the hooks persistence
  (below) uses to flush on last-client-leave and to announce a confirmed
  write back out over SSE.

The wire format stays plain JSON, as phase 1's own doc already argued for:
a Yjs update is base64-encoded inside a JSON body/event
(`base64.ts` — a small hand-rolled codec, not `Buffer`/`btoa`, since this
module is shared between the Node/Bun server and the browser client).
`POST /rooms/:surface/update` accepts `{ update: string }`, arktype-checked
for shape and then size-capped at `MAX_DOC_UPDATE_BYTES` (256 KiB decoded)
before it ever reaches Yjs — comfortably above a large paste, well below
"megabyte update" territory. A malformed update (bad base64, or valid
base64 that isn't a real Yjs update) is a 400, never silently dropped or
partially applied. `POST /rooms/:surface/join`'s response grew a
`docUpdate` field — the room's current full state, so a late joiner
converges immediately instead of starting from an empty doc. The SSE
stream carries two new event types alongside `presence.state`:
`doc.update` (every applied update, relayed to every other subscriber) and
`doc.saved` (see Persistence, below).

`POST /rooms/:surface/update` is the one presence route phase 2 gates
behind a grant: `CreatePresenceRoutesDeps.requireGrant`, when supplied,
checks `("asset:*", "write")` before an update is ever applied — the same
grant Library's own upload route checks. Join/heartbeat/leave/stream stay
exactly as open as phase 1 left them; waving a cursor was never a write,
but mutating shared content that persistence turns into a real artifact
version is. `apps/hub/src/index.ts` wires this with the same
`chatGrantStore`/`chatConditionRegistry` every other extension route uses.

### Persistence

`artifact-persistence.ts`'s `createArtifactDocPersistence` is a new,
separate module layered on top of the registry — the registry itself still
never touches storage, matching phase 1's explicit intent. It is
constructed with two injected ports (`loadArtifactContent`,
`writeArtifactSnapshot`) so the package never imports `@corbits/artifacts`
directly; `apps/hub/src/index.ts`'s composition root wires those ports to
the engine's own `getArtifact`/`writeArtifactVersion` — the same
versioned-row seam a workflow's own artifact revision goes through, so a
co-edited document's history reads identically to any other revision.

- **Convention**: a surface of the form `artifact:<artifactId>` is a
  canvas artifact; `artifactIdForSurface` is the one place that convention
  lives. Any other surface (e.g. `channel:<id>`) is invisible to
  persistence — `onDocChange`/`onEmpty` fire for it same as any room, but
  `artifactIdForSurface` returns `null` and nothing is scheduled.
- **Seed on join**: `seedOnJoin`, called from the join route's `onJoin`
  hook, loads the artifact's stored content into a still-empty room's
  `Y.Text` — `registry.seedDocText` itself refuses to overwrite non-empty
  content, so a race against a real edit can never lose data.
- **Debounce**: every doc change reschedules a per-room timer; a write
  only happens after `debounceMs` (default 2000ms, never lower — "never
  persist mid-typing chaos" is a product requirement, not a tuning knob)
  of quiet.
- **Flush on empty**: `registry.onEmpty` triggers an immediate flush,
  bypassing the debounce — the last person leaving a room is a natural
  save point, not something worth waiting 2 more seconds for.
- **Saved notification**: a successful write calls
  `registry.notifySnapshot(key, { version, savedAt })`, which the SSE
  route relays as a `doc.saved` event. This is the only source the UI
  trusts for "Saved · v12" — the client cannot otherwise know a debounced
  server-side write landed, and never claims one did without it.
- A write failure (e.g. the artifact was deleted, or archived, mid-edit)
  reports through `onSnapshotError` rather than throwing into the
  registry's synchronous event dispatch; `apps/hub` logs it.

Text artifacts only: the `Y.Doc` holds one `Y.Text` (`content`) mirroring
the artifact's `content` column verbatim. Non-text kinds never get a doc
at all — `artifact-text-editor.tsx` (below) only ever mounts for a "doc"
`rendererKind`.

### UI: `@corbits/artifact-ui`'s `ArtifactTextEditor`

A plain `<textarea>` bound to the shared `Y.Text`, not a rich-text editor
dependency — `y-text-diff.ts`'s `diffText` computes the single contiguous
region a textarea's `input` event changed (common prefix + common suffix),
and `applyTextDiffToYText` replays it as a `Y.Text` delete+insert, so a
keystroke stays a small Yjs operation instead of "replace the whole
field." Remote changes (including the initial doc-sync snapshot) flow the
other way through `yText.observe`.

The component always renders for a "doc"-kind artifact once the host hands
it a synced `Y.Doc` — regardless of write access. A viewer without
`canEdit` still sees the same live-updating textarea, just `readOnly`:
"read-only viewers see live updates" was a requirement, not just an
editing nicety. `apps/web/src/shell/canvas-column.tsx`'s
`ArtifactCanvasPane` picks `ArtifactTextEditor` over the static
`ArtifactRenderer` whenever `artifact.rendererKind === "doc"` and a doc is
present; every other kind, and a "doc" artifact whose presence connection
hasn't handed over a doc yet, still renders through `ArtifactRenderer`.

`save-state.ts`'s `ArtifactSaveState` is the explicit, honest state
machine behind the pane's status line: `"read-only"` (nothing to report),
`"editing"` (named from presence's existing `typing` awareness field —
no new wire format needed), `"unsaved"` (local edits exist, no
confirmation yet), or `"saved"` (a real `doc.saved` event landed —
rendered as `"Saved just now · v12"`, `"Saved 5m ago · v12"`, etc., never
a fabricated autosave claim). `apps/web/src/shell/app-shell.tsx` owns this
state machine: one `Y.Doc` per open artifact id (torn down and replaced
the moment a different artifact opens), `usePresenceRoom`'s new `doc`/
`onSaved` options wired to it, and `editingCoworkers` derived from the
room's own member snapshot (excluding the local viewer).

`apps/web/src/chat-artifact-open.ts`'s `artifactContentFromDetail` (the
one path that opens a real Library artifact — as opposed to a blob-only
chat attachment with no backing artifact row) sets `canEdit: true` for a
"doc"-kind result. The presence `/update` route's grant check is the real
security boundary regardless of this flag; a known simplification of this
pass is that the UI doesn't yet pre-check the viewer's own grant before
showing the editable pane — an unauthorized keystroke is rejected
server-side (never applied, never counted toward a save), but the client
doesn't yet detect that rejection and downgrade its own affordance to
read-only. Tightening that is follow-up work, not a correctness or
security gap in what shipped.

### What's deliberately not in this phase

Relative-position (Yjs `RelativePosition`) co-editor carets anchored
inside the text itself are not implemented — phase 1's cursor overlay
(fractional pointer position over the pane, colored by
`colorForPrincipal`) still renders as-is for an artifact pane, editable or
not, and remains the only in-pane presence indicator. A precise
per-character caret that survives a concurrent reflow is real future
work, not something this pass silently dropped from spec: the doc-sync
protocol (`applyDocUpdate`, `docStateAsUpdate`) is the exact substrate it
would build on, the same way phase 1 predicted.
