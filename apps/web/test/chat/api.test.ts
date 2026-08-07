// The chat API client, tested at our wiring the same way test/auth.test.tsx
// tests session.ts: stub global fetch, call the exported function, assert
// both the request it made and how it parses the response.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ChatApiError,
  createChannel,
  deploymentDisplayName,
  listChannels,
  listDeployedAgents,
  listMessages,
  sendMessage,
} from "../../src/chat/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("listChannels", () => {
  test("fetches the tenant's channels filtered by kind and parses the envelope", async () => {
    const calls = stubFetch(() =>
      json({
        items: [
          {
            id: "c1",
            title: "General",
            kind: "channel",
            pinned: true,
            participants: [],
          },
        ],
      }),
    );
    const channels = await listChannels("tenant_1", "channel");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/channels?kind=channel",
    );
    expect(channels).toEqual([
      {
        id: "c1",
        title: "General",
        kind: "channel",
        pinned: true,
        participants: [],
      },
    ]);
  });

  test("throws a ChatApiError on a malformed response", async () => {
    stubFetch(() => json({ items: [{ id: "c1" }] }));
    await expect(listChannels("tenant_1", "chat")).rejects.toBeInstanceOf(
      ChatApiError,
    );
  });

  test("throws a ChatApiError on 401", async () => {
    stubFetch(() => json(null, 401));
    await expect(listChannels("tenant_1", "chat")).rejects.toThrow(
      /Not signed in/,
    );
  });
});

describe("createChannel", () => {
  test("posts the name and kind and returns the created channel", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "c2",
          title: "Ops",
          kind: "channel",
          pinned: true,
          participants: [],
        },
        201,
      ),
    );
    const channel = await createChannel("tenant_1", {
      kind: "channel",
      name: "Ops",
    });
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/channels");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "channel",
      name: "Ops",
    });
    expect(channel.id).toBe("c2");
  });
});

describe("sendMessage", () => {
  test("posts a single-element Part array containing the TextPart", async () => {
    const calls = stubFetch(() =>
      json({ id: "m1", createdAt: "2026-01-01T00:00:00.000Z" }, 201),
    );
    await sendMessage("tenant_1", "chan_1", [{ kind: "text", text: "hello" }]);
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/channels/chan_1/messages",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual([
      { kind: "text", text: "hello" },
    ]);
  });
});

describe("listMessages", () => {
  test("decodes a mixed-kind message list", async () => {
    stubFetch(() =>
      json({
        items: [
          {
            id: "m1",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", text: "hi" }],
          },
        ],
      }),
    );
    const page = await listMessages("tenant_1", "chan_1");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.parts[0]).toEqual({ kind: "text", text: "hi" });
  });

  test("decodes a message carrying the new sender field", async () => {
    stubFetch(() =>
      json({
        items: [
          {
            id: "m2",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", text: "hi" }],
            sender: {
              name: "Researcher",
              address: "researcher@agents.example",
            },
          },
        ],
      }),
    );
    const page = await listMessages("tenant_1", "chan_1");
    expect(page.items[0]?.sender).toEqual({
      name: "Researcher",
      address: "researcher@agents.example",
    });
  });

  test("tolerates a response with no sender field", async () => {
    stubFetch(() =>
      json({
        items: [
          {
            id: "m3",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", text: "hi" }],
          },
        ],
      }),
    );
    const page = await listMessages("tenant_1", "chan_1");
    expect(page.items[0]?.sender).toBeUndefined();
  });
});

describe("listDeployedAgents", () => {
  test("parses the deployments listing", async () => {
    stubFetch(() =>
      json([
        {
          id: "run_1",
          tenantId: "tenant_1",
          definitionAssetId: "agents/researcher/workflow.json",
          status: "deployed",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const deployments = await listDeployedAgents("tenant_1");
    expect(deployments).toHaveLength(1);
    const [deployment] = deployments;
    expect(deployment !== undefined && deploymentDisplayName(deployment)).toBe(
      "workflow",
    );
  });
});

describe("deploymentDisplayName", () => {
  test("falls back to the raw asset id when it has no path shape", () => {
    expect(
      deploymentDisplayName({
        id: "run_1",
        tenantId: "t1",
        definitionAssetId: "researcher",
        status: "deployed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("researcher");
  });
});
