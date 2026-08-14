// The presence HTTP surface: join/heartbeat/leave over plain POSTs, and a
// live SSE stream of the room's awareness snapshot — mounted by the hub
// inside its own tenant-scoped middleware (see apps/hub/src/index.ts), so
// `TenantEnv`'s `tenant`/`principal` are always resolved before a handler
// here runs. No new auth path: identity and tenant membership ride the
// platform's existing session + tenant resolution, exactly like every
// other extension mounted under `TENANT_PREFIX`.
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type } from "arktype";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import { decodeBase64, encodeBase64, InvalidBase64Error } from "./base64";
import { colorForPrincipal } from "./color";
import {
  createPresenceRoomRegistry,
  type PresenceRoomKey,
  type PresenceRoomRegistry,
  type PresenceState,
} from "./room-registry";
import {
  MAX_DOC_UPDATE_BYTES,
  PresenceDocUpdateBody,
  PresenceHeartbeatBody,
  PresenceJoinBody,
} from "./schema";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export interface CreatePresenceRoutesDeps {
  registry?: PresenceRoomRegistry;
  heartbeatTimeoutMs?: number;
  now?: () => number;
  /** Decoded-byte ceiling for a single `POST /update` body. */
  maxDocUpdateBytes?: number;
  /**
   * Runs after a successful join, before the response's `docUpdate` is
   * read off the registry — the seam persistence's seed-on-join hook
   * (`createArtifactDocPersistence`) uses to populate a freshly-created
   * artifact room's doc from the artifact's stored content before the
   * joiner ever sees it. Optional: a bare presence room (no artifact
   * behind it) has no seeding to do.
   */
  onJoin?: (key: PresenceRoomKey, principalId: string) => Promise<void> | void;
  /**
   * Gates `POST /update` only — join/heartbeat/leave/stream stay exactly
   * as open as phase 1 left them (waving a cursor is not a write). A doc
   * update is different: it mutates shared content that persistence may
   * turn into a real artifact version, the same kind of write Library's
   * own upload route gates behind `("asset:*", "write")`. Optional so a
   * presence-only deployment (no doc content ever posted) doesn't have to
   * supply a grant checker it will never exercise.
   */
  requireGrant?: RequireGrant;
}

/**
 * Every mutating request opportunistically sweeps its own room for stale
 * clients before acting. This is deliberately not a background timer: a
 * timer running forever in every process that imports this module would
 * outlive tests and complicate shutdown for no real gain — the heartbeat
 * protocol already guarantees frequent-enough traffic (joins, heartbeats,
 * and the SSE `stream` route's own subscribe/unsubscribe) that a stale
 * client is caught within one timeout window of the next request to its
 * room, which is the only guarantee "ephemeral, no persistence" presence
 * needs.
 */
export function createPresenceRoutes(
  deps: CreatePresenceRoutesDeps = {},
): Hono<TenantEnv> {
  const registry = deps.registry ?? createPresenceRoomRegistry();
  const heartbeatTimeoutMs =
    deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const maxDocUpdateBytes = deps.maxDocUpdateBytes ?? MAX_DOC_UPDATE_BYTES;

  const app = new Hono<TenantEnv>();

  app.post("/rooms/:surface/join", async (c) => {
    const body = PresenceJoinBody(await c.req.json().catch(() => ({})));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid join body: ${body.summary}`),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const user = c.get("user");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    registry.sweepStale(heartbeatTimeoutMs, now());

    const state: PresenceState = {
      principalId: principal.id,
      displayName: body.displayName ?? user?.name ?? principal.id,
      color: colorForPrincipal(principal.id),
      ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
      ...(body.typing !== undefined ? { typing: body.typing } : {}),
    };

    const states = registry.join(key, state, now());
    await deps.onJoin?.(key, principal.id);
    const docUpdate = encodeBase64(registry.docStateAsUpdate(key));
    return c.json({ self: state, members: states, docUpdate }, 200);
  });

  app.post("/rooms/:surface/heartbeat", async (c) => {
    const body = PresenceHeartbeatBody(await c.req.json().catch(() => ({})));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid heartbeat body: ${body.summary}`),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    registry.sweepStale(heartbeatTimeoutMs, now());

    const patch = {
      ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
      ...(body.typing !== undefined ? { typing: body.typing } : {}),
    };
    const states = registry.heartbeat(key, principal.id, patch, now());
    if (states === undefined) {
      return c.json(
        errorEnvelope("not_joined", "principal has not joined this room"),
        404,
      );
    }
    return c.json({ members: states });
  });

  const handleDocUpdate = async (
    c: Context<TenantEnv, "/rooms/:surface/update">,
  ) => {
    const body = PresenceDocUpdateBody(await c.req.json().catch(() => ({})));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid update body: ${body.summary}`),
        400,
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(body.update);
    } catch (err) {
      if (err instanceof InvalidBase64Error) {
        return c.json(
          errorEnvelope("bad_request", "update is not valid base64"),
          400,
        );
      }
      throw err;
    }

    if (bytes.byteLength > maxDocUpdateBytes) {
      return c.json(
        errorEnvelope(
          "payload_too_large",
          `update exceeds the ${maxDocUpdateBytes} byte limit`,
        ),
        413,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    try {
      registry.applyDocUpdate(key, bytes, principal.id);
    } catch {
      return c.json(
        errorEnvelope("bad_request", "update is not a valid Yjs update"),
        400,
      );
    }

    return c.body(null, 202);
  };

  if (deps.requireGrant) {
    app.post(
      "/rooms/:surface/update",
      deps.requireGrant("asset:*", "write"),
      handleDocUpdate,
    );
  } else {
    app.post("/rooms/:surface/update", handleDocUpdate);
  }

  app.post("/rooms/:surface/leave", (c) => {
    const tenant = c.get("tenant");
    const principal = c.get("principal");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    registry.leave(key, principal.id);
    return c.body(null, 202);
  });

  app.get("/rooms/:surface/stream", (c) => {
    const tenant = c.get("tenant");
    const surface = c.req.param("surface");
    const key = { tenantId: tenant.id, surface };

    return streamSSE(c, async (stream) => {
      let unsubscribePresence: () => void = () => undefined;
      let unsubscribeDoc: () => void = () => undefined;
      let unsubscribeSnapshots: () => void = () => undefined;
      const teardown = () => {
        unsubscribePresence();
        unsubscribeDoc();
        unsubscribeSnapshots();
      };
      unsubscribePresence = registry.subscribe(key, (states) => {
        stream
          .writeSSE({ event: "presence.state", data: JSON.stringify(states) })
          .catch(teardown);
      });
      unsubscribeDoc = registry.subscribeDocUpdates(key, (update) => {
        stream
          .writeSSE({
            event: "doc.update",
            data: JSON.stringify({ update: encodeBase64(update) }),
          })
          .catch(teardown);
      });
      unsubscribeSnapshots = registry.subscribeSnapshots(key, (info) => {
        stream
          .writeSSE({ event: "doc.saved", data: JSON.stringify(info) })
          .catch(teardown);
      });
      stream.onAbort(teardown);
      await new Promise<void>(() => undefined);
    });
  });

  return app;
}
