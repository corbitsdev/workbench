import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createFireAgentTools, FIRE_AGENT_DEFINITIONS } from "./fire-agent";
import type { FirecrawlFetch } from "./shared";

type FetchStub = FirecrawlFetch & {
  mock: { calls: [string, RequestInit][] };
};

function makeFetchStub(response: unknown, status = 200): FetchStub {
  return mock((_input: string, _init: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify(response), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("createFireAgentTools", () => {
  it("returns the /agent tool", () => {
    const tools = createFireAgentTools({ apiKey: "test-key" });

    expect(tools.map((tool) => tool.definition.name)).toEqual(
      FIRE_AGENT_DEFINITIONS.map((definition) => definition.name),
    );
  });
});

describe("firecrawl_agent handler", () => {
  it("posts to /agent with prompt and optional schema", async () => {
    const fetcher = makeFetchStub({ success: true, data: { answer: "42" } });
    const runner = createToolRunner(
      createFireAgentTools({ apiKey: "test-key", fetcher }),
    );
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
    };

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_agent",
        arguments: {
          prompt: "What is the meaning of life?",
          schema,
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/agent");
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      prompt: "What is the meaning of life?",
      schema,
    });
  });

  it("requires a prompt", async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(
      createFireAgentTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_agent", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("prompt must be a string");
  });

  it("surfaces API errors", async () => {
    const fetcher = makeFetchStub({ error: "Invalid API key" }, 401);
    const runner = createToolRunner(
      createFireAgentTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_agent",
        arguments: { prompt: "test" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Firecrawl API error: 401");
  });
});
