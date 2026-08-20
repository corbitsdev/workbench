// HTTP surface for message pinning: membership gating, pin/unpin/list,
// tenant isolation, the batched `pinned` field on `GET /messages`, the
// pinned-strip's own `GET /pins` read, and the `chat.pin` SSE event.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createInMemoryPinStore } from "../src/pins";
import { createWorkbenchSubscriberRegistry } from "../src/workbench-events";
import type { ChatWorkbenchEvent } from "../src/platform-port";
import { buildDeps, createWorkbench, mountAs, sendText } from "./test-support";

function pinUrl(workbenchId: string, messageId: string) {
  return `/workbenches/${workbenchId}/messages/${messageId}/pin`;
}

async function pin(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
  messageId: string,
) {
  return app.request(pinUrl(workbenchId, messageId), { method: "POST" });
}

async function unpin(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
  messageId: string,
) {
  return app.request(pinUrl(workbenchId, messageId), { method: "DELETE" });
}

/** Sends a real message and returns its id — pin tests that expect a
 * 200/204 round trip need a message that actually exists, now that
 * pinning an unknown id 404s. */
async function sendAndGetMessageId(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
): Promise<string> {
  await sendText(app, workbenchId, "hello");
  const list = await app.request(`/workbenches/${workbenchId}/messages`);
  const body = (await list.json()) as { items: { id: string }[] };
  const id = body.items[0]?.id;
  if (id === undefined) throw new Error("sendAndGetMessageId: no message id");
  return id;
}

describe("pin routes — gating", () => {
  test("no pins store injected: pin, unpin, and list all 404", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    expect((await pin(app, workbench.id, "m1")).status).toBe(404);
    expect((await unpin(app, workbench.id, "m1")).status).toBe(404);
    expect(
      (await app.request(`/workbenches/${workbench.id}/pins`)).status,
    ).toBe(404);
  });

  test("a denied grant is rejected before any pin is stored", async () => {
    const store = createInMemoryPinStore();
    const deps = buildDeps({
      pins: store,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = "run_workbench1";

    const response = await pin(app, workbenchId, "m1");
    expect(response.status).toBe(403);
    expect(await store.listPins("tnt_1", workbenchId)).toHaveLength(0);
  });

  test("an unknown workbench id 404s", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    expect((await pin(app, "run_ghost", "m1")).status).toBe(404);
  });

  test("a workbench that belongs to a different tenant is invisible: 404, not leaked cross-tenant", async () => {
    const store = createInMemoryPinStore();
    const deps = buildDeps({ pins: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body } = await createWorkbench(app, { kind: "workbench" });

    const otherApp = mountAs(
      createChatRoutes(buildDeps({ pins: store })),
      "prn_mallory",
    );
    expect((await pin(otherApp, body.id, "m1")).status).toBe(404);
  });

  test("a messageId that was never sent 404s rather than writing an orphaned pin row", async () => {
    const store = createInMemoryPinStore();
    const deps = buildDeps({ pins: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    // A real message exists in the workbench, but "m_ghost" is not it —
    // proves the check resolves the specific id, not just "some
    // message exists in this workbench".
    await sendText(app, workbench.id, "unrelated message");

    const response = await pin(app, workbench.id, "m_ghost");
    expect(response.status).toBe(404);
    expect(await store.listPins("tnt_1", workbench.id)).toHaveLength(0);
  });
});

describe("pin routes — pin/unpin round trip", () => {
  test("pinning then GET /pins returns it with the message's own content", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await sendText(app, workbench.id, "important announcement");

    const list = await app.request(`/workbenches/${workbench.id}/messages`);
    const listed = (await list.json()) as { items: { id: string }[] };
    const messageId = listed.items[0]?.id as string;

    const pinResponse = await pin(app, workbench.id, messageId);
    expect(pinResponse.status).toBe(200);
    const pinBody = (await pinResponse.json()) as {
      messageId: string;
      pinnedBy: string;
    };
    expect(pinBody).toMatchObject({ messageId, pinnedBy: "prn_alice" });

    const pins = await app.request(`/workbenches/${workbench.id}/pins`);
    const pinsBody = (await pins.json()) as {
      items: { id: string; parts: { kind: string; text?: string }[] }[];
    };
    expect(pinsBody.items).toHaveLength(1);
    expect(pinsBody.items[0]?.id).toBe(messageId);
  });

  test("unpinning removes it from GET /pins", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await sendText(app, workbench.id, "hello");

    const list = await app.request(`/workbenches/${workbench.id}/messages`);
    const listed = (await list.json()) as { items: { id: string }[] };
    const messageId = listed.items[0]?.id as string;

    await pin(app, workbench.id, messageId);
    const unpinResponse = await unpin(app, workbench.id, messageId);
    expect(unpinResponse.status).toBe(204);

    const pins = await app.request(`/workbenches/${workbench.id}/pins`);
    const pinsBody = (await pins.json()) as { items: unknown[] };
    expect(pinsBody.items).toEqual([]);
  });
});

describe("pin routes — the message wire type carries pinned", () => {
  test("GET /messages marks each item pinned or not, batched from one listPins call", async () => {
    const deps = buildDeps({ pins: createInMemoryPinStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await sendText(app, workbench.id, "one");
    await sendText(app, workbench.id, "two");

    const before = await app.request(`/workbenches/${workbench.id}/messages`);
    const beforeBody = (await before.json()) as {
      items: { id: string; pinned?: boolean }[];
    };
    expect(beforeBody.items.every((item) => item.pinned === false)).toBe(true);

    const targetId = beforeBody.items[0]?.id as string;
    await pin(app, workbench.id, targetId);

    const after = await app.request(`/workbenches/${workbench.id}/messages`);
    const afterBody = (await after.json()) as {
      items: { id: string; pinned?: boolean }[];
    };
    const byId = new Map(afterBody.items.map((item) => [item.id, item.pinned]));
    expect(byId.get(targetId)).toBe(true);
  });

  test("without a pins store, the pinned field is simply absent", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await sendText(app, workbench.id, "hello");

    const list = await app.request(`/workbenches/${workbench.id}/messages`);
    const body = (await list.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty("pinned");
  });
});

describe("pin routes — chat.pin SSE event", () => {
  test("pinning and unpinning both publish onto the workbench's subscriber registry", async () => {
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      pins: createInMemoryPinStore(),
      workbenchSubscribers,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    const messageId = await sendAndGetMessageId(app, workbench.id);

    const received: ChatWorkbenchEvent[] = [];
    workbenchSubscribers.subscribe(workbench.id, (event) =>
      received.push(event),
    );

    await pin(app, workbench.id, messageId);
    await unpin(app, workbench.id, messageId);

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      type: "chat.pin",
      data: { messageId, pinned: true },
    });
    expect(received[1]).toMatchObject({
      type: "chat.pin",
      data: { messageId, pinned: false },
    });
  });
});
