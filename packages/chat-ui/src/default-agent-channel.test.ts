import { afterEach, describe, expect, test } from "bun:test";

import {
  createDefaultAgentChannel,
  isChannelTitleMatch,
} from "./default-agent-channel";
import type { Channel } from "./api";

function channel(partial: {
  readonly id: string;
  readonly title: string;
  readonly kind?: string;
}): Channel {
  return {
    id: partial.id,
    title: partial.title,
    kind: partial.kind ?? "channel",
    pinned: false,
    participants: [],
  };
}

type StubDefinition = { readonly id: string; readonly name: string };

function definition(id: string, name: string): StubDefinition {
  return { id, name };
}

describe("isChannelTitleMatch", () => {
  test("is case-insensitive and trims", () => {
    expect(isChannelTitleMatch("Myra", "Myra")).toBe(true);
    expect(isChannelTitleMatch(" myra ", "Myra")).toBe(true);
    expect(isChannelTitleMatch("MYRA", "Myra")).toBe(true);
    expect(isChannelTitleMatch("Myra chat", "Myra")).toBe(false);
    expect(isChannelTitleMatch("Assistant", "Myra")).toBe(false);
  });
});

describe("createDefaultAgentChannel", () => {
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

  test("isCachedChannelId is false until a channel id is cached", () => {
    const agent = createDefaultAgentChannel({
      title: "Myra",
      assetName: "assistant",
    });
    expect(agent.isCachedChannelId("chan-1")).toBe(false);
    expect(agent.isCachedChannelId(null)).toBe(false);
  });

  test("findChannelByTitle returns the first title match", () => {
    const agent = createDefaultAgentChannel({
      title: "Myra",
      assetName: "assistant",
    });
    const items = [
      channel({ id: "a", title: "general" }),
      channel({ id: "b", title: "myra" }),
      channel({ id: "c", title: "Myra" }),
    ];
    expect(agent.findChannelByTitle(items)?.id).toBe("b");
    expect(
      agent.findChannelByTitle([channel({ id: "a", title: "general" })]),
    ).toBeUndefined();
  });

  test("creates a chat with the definitionId when no title match exists", async () => {
    const agent = createDefaultAgentChannel({
      title: "Myra",
      assetName: "assistant",
    });
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel"))
        return json({ items: [] });
      if (path.endsWith("/chat/channels?kind=chat")) return json({ items: [] });
      if (path.endsWith("/chat/channels")) {
        return json({
          id: "chat-1",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await agent.ensure("tnt_1", async () => [
      definition("def-assistant", "assistant"),
    ]);

    expect(result).toEqual({ kind: "ready", channelId: "chat-1" });
    const createCall = calls.find((call) =>
      call.path.endsWith("/chat/channels"),
    );
    expect(createCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "def-assistant",
      name: "Myra",
    });
    expect(agent.isCachedChannelId("chat-1")).toBe(true);
  });

  test("reuses an existing title match instead of creating a channel", async () => {
    const agent = createDefaultAgentChannel({
      title: "Myra",
      assetName: "assistant",
    });
    stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel")) {
        return json({
          items: [
            {
              id: "legacy-1",
              title: "Myra",
              kind: "channel",
              pinned: false,
              participants: [],
            },
          ],
        });
      }
      if (path.endsWith("/chat/channels?kind=chat")) return json({ items: [] });
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await agent.ensure("tnt_1", async () => []);

    expect(result).toEqual({ kind: "ready", channelId: "legacy-1" });
    expect(agent.isCachedChannelId("legacy-1")).toBe(true);
  });

  test("errors when no definition matches the configured asset name", async () => {
    const agent = createDefaultAgentChannel({
      title: "Myra",
      assetName: "assistant",
    });
    stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel"))
        return json({ items: [] });
      if (path.endsWith("/chat/channels?kind=chat")) return json({ items: [] });
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await agent.ensure("tnt_1", async () => [
      definition("def-echo", "echo"),
    ]);

    expect(result.kind).toBe("error");
  });

  test("errors when the configured asset name is undefined", async () => {
    const agent = createDefaultAgentChannel({
      title: "Myra",
      assetName: undefined,
    });
    stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel"))
        return json({ items: [] });
      if (path.endsWith("/chat/channels?kind=chat")) return json({ items: [] });
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await agent.ensure("tnt_1", async () => [
      definition("def-echo", "echo"),
    ]);

    expect(result.kind).toBe("error");
  });

  test("resetCache clears the cached id", async () => {
    const agent = createDefaultAgentChannel({
      title: "Myra",
      assetName: "assistant",
    });
    stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel")) {
        return json({
          items: [
            {
              id: "legacy-1",
              title: "Myra",
              kind: "channel",
              pinned: false,
              participants: [],
            },
          ],
        });
      }
      if (path.endsWith("/chat/channels?kind=chat")) return json({ items: [] });
      throw new Error(`unexpected fetch: ${path}`);
    });

    await agent.ensure("tnt_1", async () => []);
    expect(agent.isCachedChannelId("legacy-1")).toBe(true);
    agent.resetCache();
    expect(agent.isCachedChannelId("legacy-1")).toBe(false);
  });
});
