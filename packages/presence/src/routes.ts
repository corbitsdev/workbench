// The presence HTTP surface: join/heartbeat/leave over plain POSTs, and a
// live SSE stream of the room's awareness snapshot — mounted by the hub
// inside its own tenant-scoped middleware (see apps/hub/src/index.ts), so
// `TenantEnv`'s `tenant`/`principal` are always resolved before a handler
// here runs. No new auth path: identity and tenant membership ride the
// platform's existing session + tenant resolution, exactly like every
// other extension mounted under `TENANT_PREFIX`.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type } from "arktype";

import type { TenantEnv } from "@intx/hub-api";

import { colorForPrincipal } from "./color";
import {
  createPresenceRoomRegistry,
  type PresenceRoomRegistry,
  type PresenceState,
} from "./room-registry";
import { PresenceHeartbeatBody, PresenceJoinBody } from "./schema";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export interface CreatePresenceRoutesDeps {
  registry?: PresenceRoomRegistry;
  heartbeatTimeoutMs?: number;
  now?: () => number;
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
    return c.json({ self: state, members: states }, 200);
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
      let unsubscribe: () => void = () => undefined;
      unsubscribe = registry.subscribe(key, (states) => {
        stream
          .writeSSE({ event: "presence.state", data: JSON.stringify(states) })
          .catch(() => unsubscribe());
      });
      stream.onAbort(unsubscribe);
      await new Promise<void>(() => undefined);
    });
  });

  return app;
}
