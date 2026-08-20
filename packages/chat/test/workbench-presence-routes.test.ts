// CL-6328: presence piggybacks on the same `/workbenches/:id/stream`
// SSE connection `chat.typing` already rides — never a durable row,
// never a poll. Covers the full HTTP surface: a stream connection's
// snapshot/online delta, `POST .../presence`'s ping (and its 404 for a
// principal with no open connection), and that none of it ever touches
// `store`.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createWorkbenchSubscriberRegistry } from "../src/workbench-events";
import { createWorkbenchPresenceRegistry } from "../src/workbench-presence";
import { buildDeps, createWorkbench, mountAs } from "./test-support";

async function openStream(app: ReturnType<typeof mountAs>, url: string) {
  const response = await app.request(url);
  expect(response.status).toBe(200);
  const body = response.body;
  if (body === null) throw new Error("stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  return {
    reader,
    async readChunk(timeoutMs = 2_000): Promise<string | undefined> {
      return Promise.race([
        reader
          .read()
          .then((result) =>
            result.done ? undefined : decoder.decode(result.value),
          ),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), timeoutMs),
        ),
      ]);
    },
  };
}

describe("presence", () => {
  test("connecting to the stream hands it a snapshot and broadcasts an online delta", async () => {
    const presence = createWorkbenchPresenceRegistry();
    const deps = buildDeps({ workbenchPresence: presence });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const { reader, readChunk } = await openStream(
      app,
      `/workbenches/${workbench.id}/stream`,
    );

    const first = await readChunk();
    expect(first).toContain("chat.presence.snapshot");
    expect(first).toContain("prn_alice");

    const second = await readChunk();
    expect(second).toContain("chat.presence");
    expect(second).toContain('"state":"online"');

    expect(
      presence.snapshot(workbench.id).map((member) => member.principalId),
    ).toEqual(["prn_alice"]);

    await reader.cancel().catch(() => undefined);
  });

  test("POST .../presence pings an already-connected principal onto the same stream", async () => {
    const presence = createWorkbenchPresenceRegistry();
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      workbenchPresence: presence,
      workbenchSubscribers,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const { reader, readChunk } = await openStream(
      app,
      `/workbenches/${workbench.id}/stream`,
    );
    // Drain the connect-time snapshot and online delta.
    await readChunk();
    await readChunk();

    const ping = await app.request(`/workbenches/${workbench.id}/presence`, {
      method: "POST",
    });
    expect(ping.status).toBe(202);

    const pinged = await readChunk();
    expect(pinged).toContain("chat.presence");
    expect(pinged).toContain('"state":"online"');

    await reader.cancel().catch(() => undefined);
  });

  test("POST .../presence 404s for a principal with no open stream connection", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const ping = await app.request(`/workbenches/${workbench.id}/presence`, {
      method: "POST",
    });
    expect(ping.status).toBe(404);
  });

  test("is never persisted: no settings row, no messages, regardless of connect/ping traffic", async () => {
    const presence = createWorkbenchPresenceRegistry();
    const deps = buildDeps({ workbenchPresence: presence });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const { reader, readChunk } = await openStream(
      app,
      `/workbenches/${workbench.id}/stream`,
    );
    await readChunk();
    await readChunk();
    await app.request(`/workbenches/${workbench.id}/presence`, {
      method: "POST",
    });

    const settingsRow = await deps.store.getWorkbenchSettings(
      "tnt_1",
      workbench.id,
    );
    expect(settingsRow?.settings).not.toHaveProperty("chat/presence");
    const listed = await deps.roomMessages.listMessages({
      tenantId: "tnt_1",
      workbenchId: workbench.id,
    });
    expect(listed.items).toEqual([]);

    await reader.cancel().catch(() => undefined);
  });
});
