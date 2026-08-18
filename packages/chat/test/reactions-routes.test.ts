// HTTP surface for message reactions: membership gating, curated-emoji
// validation, true toggle semantics over HTTP, tenant isolation, the
// batched `reactions` field on `GET /messages`, and the `chat.reaction`
// SSE event.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createInMemoryReactionStore } from "../src/reactions";
import { createWorkbenchSubscriberRegistry } from "../src/workbench-events";
import type { ChatWorkbenchEvent } from "../src/platform-port";
import { buildDeps, createWorkbench, mountAs, sendText } from "./test-support";

function toggleUrl(workbenchId: string, messageId: string) {
  return `/workbenches/${workbenchId}/messages/${messageId}/reactions/toggle`;
}

async function toggle(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
  messageId: string,
  emoji: string,
) {
  return app.request(toggleUrl(workbenchId, messageId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ emoji }),
  });
}

/** Sends a real message and returns its id — every toggle test below
 * that expects a 200/400 round trip (rather than a gating 403/404 that
 * never reaches the message-existence check) needs a message that
 * actually exists, now that toggling against an unknown id 404s. */
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

describe("reaction routes — gating", () => {
  test("no reactions store injected: toggle 404s, never silently no-ops", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await toggle(app, workbench.id, "m1", "👍");
    expect(response.status).toBe(404);
  });

  test("a denied grant is rejected before any reaction is stored", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({
      reactions: store,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = "run_workbench1";

    const response = await toggle(app, workbenchId, "m1", "👍");
    expect(response.status).toBe(403);
    expect(
      await store.listReactionsForMessages("tnt_1", workbenchId, ["m1"]),
    ).toHaveLength(0);
  });

  test("an unknown workbench id 404s rather than accepting a reaction into nowhere", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await toggle(app, "run_ghost", "m1", "👍");
    expect(response.status).toBe(404);
  });

  test("a workbench that belongs to a different tenant is invisible: 404, not leaked cross-tenant", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({ reactions: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body } = await createWorkbench(app, { kind: "workbench" });

    const otherDeps = buildDeps({ reactions: store });
    const otherApp = mountAs(createChatRoutes(otherDeps), "prn_mallory");

    const response = await toggle(otherApp, body.id, "m1", "👍");
    expect(response.status).toBe(404);
  });

  test("an emoji outside the curated set is rejected", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    const messageId = await sendAndGetMessageId(app, workbench.id);

    const response = await toggle(app, workbench.id, messageId, "🐙");
    expect(response.status).toBe(400);
  });

  test("a messageId that was never sent 404s rather than writing an orphaned reaction row", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({ reactions: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    // A real message exists in the workbench, but "m_ghost" is not it —
    // proves the check resolves the specific id, not just "some
    // message exists in this workbench".
    await sendText(app, workbench.id, "unrelated message");

    const response = await toggle(app, workbench.id, "m_ghost", "👍");
    expect(response.status).toBe(404);
    expect(
      await store.listReactionsForMessages("tnt_1", workbench.id, ["m_ghost"]),
    ).toHaveLength(0);
  });
});

describe("reaction routes — toggle semantics", () => {
  test("toggling adds, toggling again removes — reported over HTTP", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    const messageId = await sendAndGetMessageId(app, workbench.id);

    const first = await toggle(app, workbench.id, messageId, "👍");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      emoji: string;
      count: number;
      reactedByMe: boolean;
    };
    expect(firstBody).toEqual({ emoji: "👍", count: 1, reactedByMe: true });

    const second = await toggle(app, workbench.id, messageId, "👍");
    const secondBody = (await second.json()) as {
      emoji: string;
      count: number;
      reactedByMe: boolean;
    };
    expect(secondBody).toEqual({ emoji: "👍", count: 0, reactedByMe: false });
  });

  test("two principals reacting with the same emoji both count", async () => {
    const store = createInMemoryReactionStore();
    const deps = buildDeps({ reactions: store });
    const appAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const appBob = mountAs(createChatRoutes(deps), "prn_bob");
    const { body: workbench } = await createWorkbench(appAlice, {
      kind: "workbench",
    });
    const messageId = await sendAndGetMessageId(appAlice, workbench.id);

    await toggle(appAlice, workbench.id, messageId, "🎉");
    const bobResult = await toggle(appBob, workbench.id, messageId, "🎉");
    const bobBody = (await bobResult.json()) as { count: number };
    expect(bobBody.count).toBe(2);
  });
});

describe("reaction routes — the message wire type carries reactions", () => {
  test("GET /messages attaches a batched reactions summary onto each item", async () => {
    const deps = buildDeps({ reactions: createInMemoryReactionStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await sendText(app, workbench.id, "hello");

    const list = await app.request(`/workbenches/${workbench.id}/messages`);
    const before = (await list.json()) as {
      items: { id: string; reactions?: unknown[] }[];
    };
    const messageId = before.items[0]?.id;
    expect(messageId).toBeDefined();
    expect(before.items[0]?.reactions).toEqual([]);

    await toggle(app, workbench.id, messageId as string, "👀");

    const after = await app.request(`/workbenches/${workbench.id}/messages`);
    const afterBody = (await after.json()) as {
      items: {
        id: string;
        reactions?: { emoji: string; count: number; reactedByMe: boolean }[];
      }[];
    };
    expect(afterBody.items[0]?.reactions).toEqual([
      { emoji: "👀", count: 1, reactedByMe: true },
    ]);
  });

  test("without a reactions store, the reactions field is simply absent", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await sendText(app, workbench.id, "hello");

    const list = await app.request(`/workbenches/${workbench.id}/messages`);
    const body = (await list.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).not.toHaveProperty("reactions");
  });
});

describe("reaction routes — chat.reaction SSE event", () => {
  test("a toggle publishes onto the workbench's subscriber registry, live", async () => {
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      reactions: createInMemoryReactionStore(),
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

    await toggle(app, workbench.id, messageId, "🚀");

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "chat.reaction",
      data: { messageId, emoji: "🚀", added: true },
    });
  });
});
