import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureMyraChannel,
  findMyraChannel,
  findMyraDefinition,
  isMyraChannelId,
  isMyraChannelTitle,
  MYRA_CHANNEL_TITLE,
  resetMyraChannelCache,
} from "./myra-channel";
import type { Channel } from "@corbits/chat-ui";
import type { AgentDefinition } from "./agents-api";

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

describe("myra-channel helpers", () => {
  afterEach(() => {
    resetMyraChannelCache();
  });

  test("isMyraChannelId is false until a channel id is cached", () => {
    expect(isMyraChannelId("chan-1")).toBe(false);
    expect(isMyraChannelId(null)).toBe(false);
  });

  test("MYRA_CHANNEL_TITLE is Myra", () => {
    expect(MYRA_CHANNEL_TITLE).toBe("Myra");
  });

  test("isMyraChannelTitle is case-insensitive and trims", () => {
    expect(isMyraChannelTitle("Myra")).toBe(true);
    expect(isMyraChannelTitle(" myra ")).toBe(true);
    expect(isMyraChannelTitle("MYRA")).toBe(true);
    expect(isMyraChannelTitle("Myra chat")).toBe(false);
    expect(isMyraChannelTitle("Assistant")).toBe(false);
  });

  test("findMyraChannel returns the first Myra-titled row", () => {
    const items = [
      channel({ id: "a", title: "general" }),
      channel({ id: "b", title: "myra" }),
      channel({ id: "c", title: "Myra" }),
    ];
    expect(findMyraChannel(items)?.id).toBe("b");
  });

  test("findMyraChannel returns undefined when none match", () => {
    expect(
      findMyraChannel([channel({ id: "a", title: "general" })]),
    ).toBeUndefined();
  });
});

function definition(partial: {
  readonly id: string;
  readonly name: string;
}): AgentDefinition {
  return {
    id: partial.id,
    tenantId: "tnt_1",
    name: partial.name,
    currentVersion: "1",
    status: "deployed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("findMyraDefinition", () => {
  test("matches the seeded assistant asset, not a display name", () => {
    const definitions = [
      definition({ id: "def-echo", name: "echo" }),
      definition({ id: "def-assistant", name: "assistant" }),
    ];
    expect(findMyraDefinition(definitions)?.id).toBe("def-assistant");
  });

  test("returns undefined when no assistant definition is deployed", () => {
    expect(
      findMyraDefinition([definition({ id: "def-echo", name: "echo" })]),
    ).toBeUndefined();
  });
});

describe("ensureMyraChannel", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetMyraChannelCache();
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

  test("creates a chat with Myra's definitionId when no Myra row exists", async () => {
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel")) {
        return json({ items: [] });
      }
      if (path.endsWith("/chat/channels?kind=chat")) {
        return json({ items: [] });
      }
      if (path.includes("/workflows/definitions")) {
        return json({
          data: [definition({ id: "def-assistant", name: "assistant" })],
          nextCursor: null,
        });
      }
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

    const result = await ensureMyraChannel("tnt_1");

    expect(result).toEqual({ kind: "ready", channelId: "chat-1" });
    const createCall = calls.find((call) =>
      call.path.endsWith("/chat/channels"),
    );
    expect(createCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "def-assistant",
      name: "Myra",
      reuseExisting: true,
    });
    expect(isMyraChannelId("chat-1")).toBe(true);
  });

  test("converts a legacy channel-kind Myra row carrying the agent into an auto-responding chat", async () => {
    const legacyWire = {
      id: "legacy-1",
      title: "Myra",
      kind: "channel",
      pinned: true,
      participants: [{ address: "myra@wf_1.tnt_1", handle: "myra" }],
    };
    const calls = stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel")) {
        return json({ items: [legacyWire] });
      }
      if (path.endsWith("/chat/channels?kind=chat")) {
        return json({ items: [] });
      }
      if (path.endsWith("/chat/channels/legacy-1/settings")) {
        return json({
          ...legacyWire,
          kind: "chat",
          settings: { "chat/kind": "chat" },
          contextWindow: { value: 50, source: "inherit" },
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await ensureMyraChannel("tnt_1");

    expect(result).toEqual({ kind: "ready", channelId: "legacy-1" });
    expect(isMyraChannelId("legacy-1")).toBe(true);
    const patchCall = calls.find((call) => call.init?.method === "PATCH");
    expect(JSON.parse(String(patchCall?.init?.body))).toEqual({
      "chat/kind": "chat",
    });
  });

  test("errors when no Myra definition is deployed for the tenant", async () => {
    stubFetch((path) => {
      if (path.endsWith("/chat/channels?kind=channel"))
        return json({ items: [] });
      if (path.endsWith("/chat/channels?kind=chat")) return json({ items: [] });
      if (path.includes("/workflows/definitions")) {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });

    const result = await ensureMyraChannel("tnt_1");

    expect(result.kind).toBe("error");
  });
});
