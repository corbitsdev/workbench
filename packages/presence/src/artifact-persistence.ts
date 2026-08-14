// Debounced Yjs-doc → artifact-version persistence, layered on top of a
// `PresenceRoomRegistry` without changing the registry's own "ephemeral,
// no storage" default (see docs/presence.md's phase 2 section — phase 1's
// registry never persists anything, and this module doesn't change that
// for presence itself, only adds a snapshot path for doc content on top).
//
// This module owns exactly one convention the registry itself stays
// ignorant of: an `artifact:<artifactId>` surface names a canvas artifact
// whose room's Y.Text mirrors that artifact's content. Every dependency
// that touches real storage (`loadArtifactContent`, `writeArtifactSnapshot`)
// is injected — this module never imports `@corbits/artifacts` — so the
// hub composition root wires it to the real engine's `writeArtifactVersion`
// seam and a test wires it to an in-memory fake, the same DI shape
// `@corbits/artifacts-hub`'s `ArtifactRoutesStore` already uses.
import type { PresenceRoomKey, PresenceRoomRegistry } from "./room-registry";

const ARTIFACT_SURFACE_PREFIX = "artifact:";

/** `"artifact:art_1"` → `"art_1"`; any other surface (e.g. `"channel:…"`, or a bare `"artifact:"` with nothing after it) → `null`. */
export function artifactIdForSurface(surface: string): string | null {
  if (!surface.startsWith(ARTIFACT_SURFACE_PREFIX)) return null;
  const id = surface.slice(ARTIFACT_SURFACE_PREFIX.length);
  return id === "" ? null : id;
}

const DEFAULT_DEBOUNCE_MS = 2_000;

export interface ArtifactDocPersistenceDeps {
  readonly registry: PresenceRoomRegistry;
  /**
   * Quiet period after the last doc change before a snapshot is written.
   * Defaults to 2000ms and should never go lower — "never persist
   * mid-typing chaos" is a hard product requirement, not a tuning knob.
   */
  readonly debounceMs?: number;
  readonly now?: () => number;
  readonly setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutImpl?: (handle: unknown) => void;
  /**
   * Loads an artifact's current stored content, to seed a freshly-created
   * room's Y.Text the first time anyone joins it. Returning `null` (not
   * found, wrong kind, whatever) leaves the room's doc empty rather than
   * throwing — an editable-but-unseeded room is a safe degraded state.
   */
  loadArtifactContent(
    tenantId: string,
    artifactId: string,
  ): Promise<string | null>;
  /**
   * Writes the room's current Y.Text content as a new artifact version,
   * returning the version number written — threaded back through
   * `registry.notifySnapshot` so every connected browser can render an
   * honest "Saved · v12" line instead of guessing that a debounced
   * server-side write landed.
   */
  writeArtifactSnapshot(
    tenantId: string,
    artifactId: string,
    authorPrincipalId: string,
    content: string,
  ): Promise<{ version: number }>;
  /** Reports a failed snapshot write without throwing into the registry's synchronous event dispatch. Defaults to a no-op; the hub composition root should at least log. */
  onSnapshotError?: (key: PresenceRoomKey, error: unknown) => void;
}

export interface ArtifactDocPersistence {
  /**
   * Seeds `key`'s Y.Text with the artifact's stored content, but only for
   * an artifact surface whose doc is still empty — a no-op for a
   * non-artifact surface, a room that already has content (real edits
   * always win over a stale reseed), or an artifact the loader can't
   * resolve. Call from the join route's `onJoin` hook before the
   * response's doc snapshot is read.
   */
  seedOnJoin(key: PresenceRoomKey): Promise<void>;
  /** Cancels every pending debounce timer without flushing. Call on process shutdown only — never mid-traffic, or a pending edit's snapshot is silently dropped. */
  dispose(): void;
}

function roomKeyId(key: PresenceRoomKey): string {
  return `${key.tenantId}::${key.surface}`;
}

export function createArtifactDocPersistence(
  deps: ArtifactDocPersistenceDeps,
): ArtifactDocPersistence {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimeoutImpl =
    deps.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutImpl =
    deps.clearTimeoutImpl ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  const timers = new Map<string, unknown>();
  const pendingAuthor = new Map<string, string>();

  async function snapshot(
    key: PresenceRoomKey,
    authorPrincipalId: string,
  ): Promise<void> {
    const artifactId = artifactIdForSurface(key.surface);
    if (artifactId === null) return;
    const content = deps.registry.docText(key);
    try {
      const written = await deps.writeArtifactSnapshot(
        key.tenantId,
        artifactId,
        authorPrincipalId,
        content,
      );
      deps.registry.notifySnapshot(key, {
        version: written.version,
        savedAt: (deps.now ?? Date.now)(),
      });
    } catch (error) {
      deps.onSnapshotError?.(key, error);
    }
  }

  function scheduleSnapshot(
    key: PresenceRoomKey,
    authorPrincipalId: string,
  ): void {
    if (artifactIdForSurface(key.surface) === null) return;
    const id = roomKeyId(key);
    const existing = timers.get(id);
    if (existing !== undefined) clearTimeoutImpl(existing);
    pendingAuthor.set(id, authorPrincipalId);
    const handle = setTimeoutImpl(() => {
      timers.delete(id);
      const author = pendingAuthor.get(id);
      pendingAuthor.delete(id);
      if (author !== undefined) void snapshot(key, author);
    }, debounceMs);
    timers.set(id, handle);
  }

  function flushNow(key: PresenceRoomKey): void {
    const id = roomKeyId(key);
    const existing = timers.get(id);
    const author = pendingAuthor.get(id);
    if (existing === undefined || author === undefined) return;
    clearTimeoutImpl(existing);
    timers.delete(id);
    pendingAuthor.delete(id);
    void snapshot(key, author);
  }

  deps.registry.onDocChange((key, authorPrincipalId) => {
    scheduleSnapshot(key, authorPrincipalId);
  });

  deps.registry.onEmpty((key) => {
    flushNow(key);
  });

  return {
    async seedOnJoin(key) {
      const artifactId = artifactIdForSurface(key.surface);
      if (artifactId === null) return;
      if (deps.registry.docText(key).length > 0) return;
      const content = await deps.loadArtifactContent(key.tenantId, artifactId);
      if (content === null || content === "") return;
      deps.registry.seedDocText(key, content);
    },
    dispose() {
      for (const handle of timers.values()) clearTimeoutImpl(handle);
      timers.clear();
      pendingAuthor.clear();
    },
  };
}
