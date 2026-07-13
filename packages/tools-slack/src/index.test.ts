import { describe, expect, it } from "bun:test";
import {
  createSlackTools,
  SLACK_HUB_TOOLS,
  type SlackFetch,
  type SlackToolsConfig,
} from "./index";

type Route = (params: URLSearchParams) => unknown;

// A fetcher that dispatches on the Slack method in the URL path and records the
// form-encoded params each call received.
function makeSlackFetch(
  routes: Record<string, Route>,
): SlackFetch & { calls: { method: string; params: URLSearchParams }[] } {
  const calls: { method: string; params: URLSearchParams }[] = [];
  const fetcher = (async (input: string, init: RequestInit) => {
    const method = input.split("/").pop() ?? "";
    const params = new URLSearchParams(String(init.body ?? ""));
    calls.push({ method, params });
    const route = routes[method];
    if (!route) {
      return new Response(
        JSON.stringify({ ok: false, error: "unknown_method" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response(JSON.stringify(route(params)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as SlackFetch & { calls: typeof calls };
  fetcher.calls = calls;
  return fetcher;
}

function toolFor(name: string, config: SlackToolsConfig) {
  const tool = createSlackTools(config).find((t) => t.definition.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function run(
  name: string,
  config: SlackToolsConfig,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = toolFor(name, config);
  const handler = tool.handler as (
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
  const out = await handler(args, new AbortController().signal);
  return JSON.parse(out);
}

describe("createSlackTools", () => {
  it("exposes exactly the four Slack tools", () => {
    const names = createSlackTools({ botToken: "xoxb-x" })
      .map((t) => t.definition.name)
      .sort();
    expect(names).toEqual([
      "slack_get_channel_history",
      "slack_list_channels",
      "slack_post_message",
      "slack_search",
    ]);
  });

  it("throws when botToken is empty", () => {
    expect(() => createSlackTools({ botToken: "" })).toThrow(
      "Slack botToken is required",
    );
  });

  it("throws when baseUrl is invalid", () => {
    expect(() =>
      createSlackTools({ botToken: "xoxb-x", baseUrl: "not a url" }),
    ).toThrow("Slack baseUrl must be a valid URL");
  });
});

describe("slack_list_channels", () => {
  it("normalizes channels and passes the default public_channel type", async () => {
    const fetcher = makeSlackFetch({
      "conversations.list": () => ({
        ok: true,
        channels: [
          { id: "C1", name: "general", is_member: true },
          { id: "C2", name: "random" },
        ],
        response_metadata: { next_cursor: "next" },
      }),
    });
    const result = await run(
      "slack_list_channels",
      { botToken: "xoxb", fetcher },
      {},
    );
    expect(result).toEqual({
      channels: [
        { id: "C1", name: "general", isMember: true },
        { id: "C2", name: "random", isMember: false },
      ],
      nextCursor: "next",
    });
    expect(fetcher.calls[0]?.params.get("types")).toBe("public_channel");
  });
});

describe("slack_get_channel_history", () => {
  it("reads history by channel id and normalizes messages", async () => {
    const fetcher = makeSlackFetch({
      "conversations.history": (p) => {
        expect(p.get("channel")).toBe("C012ABCDE");
        expect(p.get("limit")).toBe("30");
        return {
          ok: true,
          messages: [
            { ts: "1.1", user: "U1", text: "hi", thread_ts: "1.0" },
            { ts: "1.2", bot_id: "B1", text: "beep" },
          ],
        };
      },
    });
    const result = await run(
      "slack_get_channel_history",
      { botToken: "xoxb", fetcher },
      { channel: "C012ABCDE" },
    );
    expect(result).toEqual({
      channel: "C012ABCDE",
      messages: [
        { ts: "1.1", user: "U1", text: "hi", threadTs: "1.0" },
        { ts: "1.2", user: "B1", text: "beep" },
      ],
    });
  });

  it("resolves a channel name to an id before reading", async () => {
    const fetcher = makeSlackFetch({
      "conversations.list": () => ({
        ok: true,
        channels: [{ id: "C99", name: "general" }],
      }),
      "conversations.history": (p) => {
        expect(p.get("channel")).toBe("C99");
        return { ok: true, messages: [] };
      },
    });
    const result = (await run(
      "slack_get_channel_history",
      { botToken: "xoxb", fetcher },
      { channel: "#general" },
    )) as { channel: string };
    expect(result.channel).toBe("C99");
  });

  it("uses conversations.replies when thread_ts is set", async () => {
    const fetcher = makeSlackFetch({
      "conversations.replies": (p) => {
        expect(p.get("ts")).toBe("100.5");
        return {
          ok: true,
          messages: [{ ts: "100.6", user: "U2", text: "re" }],
        };
      },
    });
    await run(
      "slack_get_channel_history",
      { botToken: "xoxb", fetcher },
      { channel: "C012ABCDE", thread_ts: "100.5" },
    );
    expect(fetcher.calls.map((c) => c.method)).toEqual([
      "conversations.replies",
    ]);
  });

  it("surfaces not_in_channel as an actionable invite message", async () => {
    const fetcher = makeSlackFetch({
      "conversations.history": () => ({ ok: false, error: "not_in_channel" }),
    });
    const tool = toolFor("slack_get_channel_history", {
      botToken: "xoxb",
      fetcher,
    });
    await expect(
      (
        tool.handler as (
          a: Record<string, unknown>,
          s: AbortSignal,
        ) => Promise<string>
      )({ channel: "C012ABCDE" }, new AbortController().signal),
    ).rejects.toThrow(/invite the bot to the channel/);
  });

  it("clamps limit to the 100 max", async () => {
    const fetcher = makeSlackFetch({
      "conversations.history": (p) => {
        expect(p.get("limit")).toBe("100");
        return { ok: true, messages: [] };
      },
    });
    await run(
      "slack_get_channel_history",
      { botToken: "xoxb", fetcher },
      { channel: "C012ABCDE", limit: 5000 },
    );
  });
});

describe("slack_post_message", () => {
  it("posts to a channel and returns the ts", async () => {
    const fetcher = makeSlackFetch({
      "chat.postMessage": (p) => {
        expect(p.get("channel")).toBe("C012ABCDE");
        expect(p.get("text")).toBe("hello");
        return { ok: true, ts: "200.1", channel: "C012ABCDE" };
      },
    });
    const result = await run(
      "slack_post_message",
      { botToken: "xoxb", fetcher },
      { channel: "C012ABCDE", text: "hello" },
    );
    expect(result).toEqual({ ok: true, channel: "C012ABCDE", ts: "200.1" });
  });

  it("is classified as a write side effect", () => {
    expect(SLACK_HUB_TOOLS.slack_post_message.sideEffect).toBe("write");
  });

  it("sends a bearer authorization header", async () => {
    let authHeader: string | undefined;
    const fetcher = (async (_input: string, init: RequestInit) => {
      authHeader = (init.headers as Record<string, string>)["Authorization"];
      return new Response(
        JSON.stringify({ ok: true, ts: "1", channel: "C1" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as SlackFetch;
    await run(
      "slack_post_message",
      { botToken: "xoxb-secret", fetcher },
      { channel: "C012ABCDE", text: "hi" },
    );
    expect(authHeader).toBe("Bearer xoxb-secret");
  });
});

describe("slack_search", () => {
  it("scans member channels and returns substring matches", async () => {
    const fetcher = makeSlackFetch({
      "users.conversations": () => ({
        ok: true,
        channels: [
          { id: "C1", name: "general" },
          { id: "C2", name: "random" },
        ],
      }),
      "conversations.history": (p) => {
        if (p.get("channel") === "C1") {
          return {
            ok: true,
            messages: [
              { ts: "1", user: "U1", text: "we shipped the WIDGET today" },
              { ts: "2", user: "U2", text: "unrelated" },
            ],
          };
        }
        return {
          ok: true,
          messages: [{ ts: "3", user: "U3", text: "no match" }],
        };
      },
    });
    const result = (await run(
      "slack_search",
      { botToken: "xoxb", fetcher },
      { query: "widget" },
    )) as {
      matches: Record<string, string>[];
      scannedChannels: number;
    };
    expect(result.scannedChannels).toBe(2);
    expect(result.matches).toEqual([
      {
        channel: "C1",
        channelName: "general",
        ts: "1",
        user: "U1",
        text: "we shipped the WIDGET today",
      },
    ]);
  });

  it("honors the match limit", async () => {
    const fetcher = makeSlackFetch({
      "users.conversations": () => ({
        ok: true,
        channels: [{ id: "C1", name: "g" }],
      }),
      "conversations.history": () => ({
        ok: true,
        messages: [
          { ts: "1", user: "U", text: "foo one" },
          { ts: "2", user: "U", text: "foo two" },
          { ts: "3", user: "U", text: "foo three" },
        ],
      }),
    });
    const result = (await run(
      "slack_search",
      { botToken: "xoxb", fetcher },
      { query: "foo", limit: 2 },
    )) as { matches: unknown[] };
    expect(result.matches.length).toBe(2);
  });
});

describe("rate limiting (HTTP 429)", () => {
  function rateLimitedThenOk(
    okBody: unknown,
    failures: number,
  ): SlackFetch & { attempts: number } {
    let attempts = 0;
    const fetcher = (async () => {
      attempts += 1;
      fetcher.attempts = attempts;
      if (attempts <= failures) {
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response(JSON.stringify(okBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as SlackFetch & { attempts: number };
    fetcher.attempts = 0;
    return fetcher;
  }

  it("retries after a 429 (Retry-After) and then succeeds", async () => {
    const fetcher = rateLimitedThenOk({ ok: true, channels: [] }, 2);
    const result = await run(
      "slack_list_channels",
      { botToken: "xoxb", fetcher },
      {},
    );
    expect(result).toEqual({ channels: [], nextCursor: undefined });
    expect(fetcher.attempts).toBe(3);
  });

  it("fails loudly once retries are exhausted", async () => {
    const fetcher = rateLimitedThenOk({ ok: true, channels: [] }, 99);
    const tool = toolFor("slack_list_channels", { botToken: "xoxb", fetcher });
    await expect(
      (
        tool.handler as (
          a: Record<string, unknown>,
          s: AbortSignal,
        ) => Promise<string>
      )({}, new AbortController().signal),
    ).rejects.toThrow(/rate-limited \(429\): exhausted/);
    expect(fetcher.attempts).toBe(4);
  });

  it("does NOT retry a non-429 error (500 throws immediately, one attempt)", async () => {
    let attempts = 0;
    const fetcher = (async () => {
      attempts += 1;
      return new Response("", { status: 500 });
    }) as SlackFetch;
    const tool = toolFor("slack_list_channels", { botToken: "xoxb", fetcher });
    await expect(
      (
        tool.handler as (
          a: Record<string, unknown>,
          s: AbortSignal,
        ) => Promise<string>
      )({}, new AbortController().signal),
    ).rejects.toThrow(/HTTP error: 500/);
    expect(attempts).toBe(1);
  });

  it("aborts a backoff wait when the signal fires", async () => {
    const fetcher = (async () =>
      new Response("", {
        status: 429,
        headers: { "Retry-After": "30" },
      })) as SlackFetch;
    const controller = new AbortController();
    const tool = toolFor("slack_list_channels", { botToken: "xoxb", fetcher });
    const pending = (
      tool.handler as (
        a: Record<string, unknown>,
        s: AbortSignal,
      ) => Promise<string>
    )({}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});

describe("channel name resolution cache", () => {
  it("resolves a name once and reuses the id on the next call", async () => {
    const calls: string[] = [];
    const routes = {
      "conversations.list": () => ({
        ok: true,
        channels: [{ id: "C777", name: "cached-chan" }],
      }),
      "conversations.history": () => ({ ok: true, messages: [] }),
    };
    const fetcher = (async (input: string, _init: RequestInit) => {
      const method = input.split("/").pop() ?? "";
      calls.push(method);
      const route = (routes as Record<string, () => unknown>)[method];
      return new Response(JSON.stringify(route ? route() : { ok: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as SlackFetch;
    const config = {
      botToken: "xoxb-cache-test",
      baseUrl: "https://cache.test/api",
      fetcher,
    };
    await run("slack_get_channel_history", config, { channel: "cached-chan" });
    await run("slack_get_channel_history", config, { channel: "cached-chan" });
    // conversations.list should fire once (first resolve); second call is cached.
    expect(calls.filter((m) => m === "conversations.list").length).toBe(1);
    expect(calls.filter((m) => m === "conversations.history").length).toBe(2);
  });

  it("does not leak a cached channel id across different bot tokens", async () => {
    const listCalls: string[] = [];
    const fetcher = (async (input: string, init: RequestInit) => {
      const method = input.split("/").pop() ?? "";
      const token =
        (init.headers as Record<string, string>).Authorization ?? "";
      if (method === "conversations.list") {
        listCalls.push(token);
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [{ id: "C_SHARED", name: "shared" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as SlackFetch;

    await run(
      "slack_get_channel_history",
      { botToken: "xoxb-workspace-A", fetcher },
      { channel: "shared" },
    );
    await run(
      "slack_get_channel_history",
      { botToken: "xoxb-workspace-B", fetcher },
      { channel: "shared" },
    );

    // Each distinct token resolves "shared" independently — no cross-workspace
    // cache hit.
    expect(listCalls).toEqual([
      "Bearer xoxb-workspace-A",
      "Bearer xoxb-workspace-B",
    ]);
  });
});

describe("SLACK_HUB_TOOLS registry entries", () => {
  it("builds a tool from a resolved credential (apiKey + baseURL)", async () => {
    // createTools builds the named tool from a resolved credential.
    const [tool] = SLACK_HUB_TOOLS.slack_list_channels.createTools({
      apiKey: "xoxb",
      baseURL: "https://slack.test/api",
    });
    expect(tool?.definition.name).toBe("slack_list_channels");

    // And the built handler honors the resolved baseURL: driving it calls
    // conversations.list against that endpoint with the default channel type.
    let calledUrl: string | undefined;
    const capturingFetch = (async (input: string, _init: RequestInit) => {
      calledUrl = input;
      return new Response(JSON.stringify({ ok: true, channels: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as SlackFetch;
    const result = await run(
      "slack_list_channels",
      {
        botToken: "xoxb",
        baseUrl: "https://slack.test/api",
        fetcher: capturingFetch,
      },
      {},
    );
    expect(calledUrl).toBe("https://slack.test/api/conversations.list");
    expect(result).toEqual({ channels: [], nextCursor: undefined });
  });

  it("marks read tools read and the post tool write", () => {
    expect(SLACK_HUB_TOOLS.slack_list_channels.sideEffect).toBe("read");
    expect(SLACK_HUB_TOOLS.slack_get_channel_history.sideEffect).toBe("read");
    expect(SLACK_HUB_TOOLS.slack_search.sideEffect).toBe("read");
    expect(SLACK_HUB_TOOLS.slack_post_message.sideEffect).toBe("write");
  });

  it("all entries resolve the slack provider", () => {
    for (const entry of Object.values(SLACK_HUB_TOOLS)) {
      expect(entry.providerName).toBe("slack");
    }
  });
});
