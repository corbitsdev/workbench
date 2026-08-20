// The spike room surface (CL-6323 Phase 0): four routes, no production
// chat machinery. Opening a room is one INSERT; sending a message is one
// INSERT plus one publish, with the agent turn dispatched after the
// response has already been written. The client reads the room once at
// mount and lives on the stream from then on, so there is no refetch to
// count after a send.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type } from "arktype";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type { TenantEnv } from "@intx/hub-api";

import type { SpikeRoomStore } from "./room-store";
import { dispatchTurn, type SpikeRoomEvent, type SpikeRoomRunDeps } from "./room-run";

const log = getLogger(["chat", "spike", "room-routes"]);

const CreateRoomBody = type({
  name: "string > 0",
  "systemPrompt?": "string",
});

const SendMessageBody = type({ body: "string > 0" });

const DEFAULT_ROOM_PROMPT =
  "You are a helpful assistant in a shared room. Answer the last message " +
  "briefly and directly.";

export type SpikeRoomSubscribers = {
  subscribe(roomId: string, subscriber: (event: SpikeRoomEvent) => void): () => void;
  publish(roomId: string, event: SpikeRoomEvent): void;
};

export function createSpikeRoomSubscribers(): SpikeRoomSubscribers {
  const byRoom = new Map<string, Set<(event: SpikeRoomEvent) => void>>();
  return {
    subscribe(roomId, subscriber) {
      const subscribers = byRoom.get(roomId) ?? new Set();
      subscribers.add(subscriber);
      byRoom.set(roomId, subscribers);
      return () => {
        subscribers.delete(subscriber);
        if (subscribers.size === 0) byRoom.delete(roomId);
      };
    },
    publish(roomId, event) {
      for (const subscriber of byRoom.get(roomId) ?? []) subscriber(event);
    },
  };
}

export type CreateSpikeRoomRoutesDeps = {
  readonly store: SpikeRoomStore;
  readonly subscribers: SpikeRoomSubscribers;
  readonly runDeps: Omit<SpikeRoomRunDeps, "store" | "publish">;
};

export function createSpikeRoomRoutes(
  deps: CreateSpikeRoomRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const runDeps: SpikeRoomRunDeps = {
    ...deps.runDeps,
    store: deps.store,
    publish: deps.subscribers.publish,
  };

  app.post("/", async (c) => {
    const body = CreateRoomBody(await c.req.json().catch(() => null));
    if (body instanceof type.errors) {
      return c.json({ error: { code: "bad_request", message: body.summary } }, 400);
    }
    const room = await deps.store.createRoom({
      id: generateId("workflowRun"),
      tenantId: c.get("tenant").id,
      name: body.name,
      systemPrompt: body.systemPrompt ?? DEFAULT_ROOM_PROMPT,
    });
    return c.json({ id: room.id, name: room.name }, 201);
  });

  app.get("/:roomId/messages", async (c) => {
    const room = await deps.store.getRoom(c.req.param("roomId"));
    if (room === undefined || room.tenantId !== c.get("tenant").id) {
      return c.json({ error: { code: "not_found", message: "room not found" } }, 404);
    }
    return c.json({ items: await deps.store.listMessages(room.id) });
  });

  app.post("/:roomId/messages", async (c) => {
    const room = await deps.store.getRoom(c.req.param("roomId"));
    if (room === undefined || room.tenantId !== c.get("tenant").id) {
      return c.json({ error: { code: "not_found", message: "room not found" } }, 404);
    }
    const body = SendMessageBody(await c.req.json().catch(() => null));
    if (body instanceof type.errors) {
      return c.json({ error: { code: "bad_request", message: body.summary } }, 400);
    }
    const principal = c.get("principal");
    const tenant = c.get("tenant");
    const message = await deps.store.insertMessage({
      id: generateId("workflowRun"),
      roomId: room.id,
      tenantId: room.tenantId,
      authorKind: "user",
      authorId: principal.id,
      body: body.body,
      runId: null,
    });
    deps.subscribers.publish(room.id, { type: "room.message", data: message });

    // The turn runs after the response: the caller's own message is already
    // durable and already on every subscriber's stream.
    queueMicrotask(() => {
      void dispatchTurn(runDeps, {
        room,
        requestMessageId: message.id,
        senderAddress: `${principal.id}@${tenant.domain}`,
        deployerPrincipalId: principal.id,
      }).catch((err: unknown) => {
        log.error`spike room ${room.id} turn dispatch failed: ${
          err instanceof Error ? err.message : String(err)
        }`;
        deps.subscribers.publish(room.id, {
          type: "room.turn",
          data: {
            turnId: `${room.id}:dispatch-failed`,
            childRunId: "",
            phase: "ended",
            status: "failed",
          },
        });
      });
    });

    return c.json(message, 201);
  });

  app.get("/:roomId/stream", async (c) => {
    const room = await deps.store.getRoom(c.req.param("roomId"));
    if (room === undefined || room.tenantId !== c.get("tenant").id) {
      return c.json({ error: { code: "not_found", message: "room not found" } }, 404);
    }
    return streamSSE(c, async (stream) => {
      const unsubscribe = deps.subscribers.subscribe(room.id, (event) => {
        void stream
          .writeSSE({ event: event.type, data: JSON.stringify(event.data) })
          .catch(() => undefined);
      });
      stream.onAbort(unsubscribe);
      await new Promise<void>(() => undefined);
    });
  });

  return app;
}
