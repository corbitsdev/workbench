// The chat API client, tested at our wiring the same way test/auth.test.tsx
// tests session.ts: stub global fetch, call the exported function, assert
// both the request it made and how it parses the response.

import { afterEach, describe, expect, test } from "bun:test";

import {
  ChatApiError,
  createChannel,
  runDisplayName,
  inviteAgent,
  listChannels,
  listRuns,
  listInvitableDefinitions,
  listMessages,
  sendMessage,
  getChannelSettings,
  patchChannelSettings,
  getBenchChatSettings,
  patchBenchChatSettings,
} from "../src/api";

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

  test("posts the definitionId (and no name) for a chat with no explicit name", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "c3",
          title: "echo",
          kind: "chat",
          pinned: false,
          participants: [],
        },
        201,
      ),
    );
    const channel = await createChannel("tenant_1", {
      kind: "chat",
      definitionId: "wfd_echo",
    });
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/channels");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_echo",
    });
    // With no explicit name, the server titles the chat by the agent's
    // handle — the client sends no name at all rather than guessing one.
    expect(channel.title).toBe("echo");
  });

  test("posts the definitionId alongside an explicit name for a chat", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "c4",
          title: "My research chat",
          kind: "chat",
          pinned: false,
          participants: [],
        },
        201,
      ),
    );
    await createChannel("tenant_1", {
      kind: "chat",
      definitionId: "wfd_echo",
      name: "My research chat",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_echo",
      name: "My research chat",
    });
  });
});

describe("sendMessage", () => {
  test("posts { parts } with the TextPart payload", async () => {
    const calls = stubFetch(() =>
      json({ id: "m1", createdAt: "2026-01-01T00:00:00.000Z" }, 201),
    );
    await sendMessage("tenant_1", "chan_1", [{ kind: "text", text: "hello" }]);
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/channels/chan_1/messages",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      parts: [{ kind: "text", text: "hello" }],
    });
  });

  test("includes threadId when posting into a thread", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "m1",
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: "thr_1",
        },
        201,
      ),
    );
    await sendMessage("tenant_1", "chan_1", [{ kind: "text", text: "reply" }], {
      threadId: "thr_1",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      parts: [{ kind: "text", text: "reply" }],
      threadId: "thr_1",
    });
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
            sender: { name: null, address: "someone@agents.example" },
          },
        ],
      }),
    );
    const page = await listMessages("tenant_1", "chan_1");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.parts[0]).toEqual({ kind: "text", text: "hi" });
  });

  test("decodes a message's sender", async () => {
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

  test("throws a ChatApiError when a message is missing its sender", async () => {
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
    await expect(listMessages("tenant_1", "chan_1")).rejects.toBeInstanceOf(
      ChatApiError,
    );
  });
});

describe("listRuns", () => {
  test("parses the runs listing", async () => {
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
    const runs = await listRuns("tenant_1");
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run !== undefined && runDisplayName(run)).toBe("workflow");
  });
});

describe("listInvitableDefinitions", () => {
  test("fetches the channel's invitable definitions", async () => {
    const calls = stubFetch(() =>
      json({ items: [{ id: "wfd_echo", name: "echo" }] }),
    );
    const items = await listInvitableDefinitions("tenant_1", "chan_1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/channels/chan_1/invitable",
    );
    expect(items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });

  test("throws a ChatApiError on a malformed response", async () => {
    stubFetch(() => json({ items: [{ id: "wfd_echo" }] }));
    await expect(
      listInvitableDefinitions("tenant_1", "chan_1"),
    ).rejects.toBeInstanceOf(ChatApiError);
  });
});

describe("inviteAgent", () => {
  test("posts the definitionId and returns the launched agent's address", async () => {
    const calls = stubFetch(() =>
      json(
        { address: "ins_invited1@acme.example", definitionId: "wfd_echo" },
        201,
      ),
    );
    const invited = await inviteAgent("tenant_1", "chan_1", "wfd_echo");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/channels/chan_1/invite",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      definitionId: "wfd_echo",
    });
    expect(invited).toEqual({
      address: "ins_invited1@acme.example",
      definitionId: "wfd_echo",
    });
  });
});

describe("getChannelSettings", () => {
  test("fetches a channel's settings by tenant and channel id", async () => {
    const calls = stubFetch(() =>
      json({
        id: "c1",
        title: "General",
        kind: "channel",
        pinned: true,
        participants: [],
        settings: { "chat/contextWindow": 5 },
        contextWindow: { value: 5, source: "override" },
      }),
    );
    const settings = await getChannelSettings("tenant_1", "c1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/channels/c1/settings",
    );
    expect(settings.settings["chat/contextWindow"]).toBe(5);
    expect(settings.contextWindow).toEqual({ value: 5, source: "override" });
  });
});

describe("patchChannelSettings", () => {
  test("PATCHes the given chat/* keys and returns the updated settings", async () => {
    const calls = stubFetch(() =>
      json({
        id: "c1",
        title: "Renamed",
        kind: "channel",
        pinned: false,
        participants: [],
        settings: {
          "chat/name": "Renamed",
          "chat/pinned": false,
          "chat/contextWindow": 0,
        },
        contextWindow: { value: 0, source: "override" },
      }),
    );
    const settings = await patchChannelSettings("tenant_1", "c1", {
      "chat/name": "Renamed",
      "chat/pinned": false,
      "chat/contextWindow": 0,
    });
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/channels/c1/settings",
    );
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      "chat/name": "Renamed",
      "chat/pinned": false,
      "chat/contextWindow": 0,
    });
    expect(settings.title).toBe("Renamed");
  });
});

describe("getBenchChatSettings", () => {
  test("fetches the bench's chat defaults", async () => {
    const calls = stubFetch(() =>
      json({ settings: { "chat/contextWindow": 30 }, contextWindow: 30 }),
    );
    const settings = await getBenchChatSettings("tenant_1");
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/bench/settings");
    expect(settings.contextWindow).toBe(30);
  });
});

describe("patchBenchChatSettings", () => {
  test("PATCHes the bench's default context window", async () => {
    const calls = stubFetch(() =>
      json({ settings: { "chat/contextWindow": 42 }, contextWindow: 42 }),
    );
    const settings = await patchBenchChatSettings("tenant_1", {
      "chat/contextWindow": 42,
    });
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/bench/settings");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      "chat/contextWindow": 42,
    });
    expect(settings.contextWindow).toBe(42);
  });
});

describe("runDisplayName", () => {
  test("never renders the raw asset id when it has no path shape", () => {
    expect(
      runDisplayName({
        id: "run_1",
        tenantId: "t1",
        definitionAssetId: "researcher",
        status: "deployed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("Untitled agent");
  });
});
