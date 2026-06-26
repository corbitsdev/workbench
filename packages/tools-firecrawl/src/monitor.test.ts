import { describe, expect, it, mock } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createMonitorTools, MONITOR_DEFINITIONS } from "./monitor";
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

describe("createMonitorTools", () => {
  it("returns all monitor tools", () => {
    const tools = createMonitorTools({ apiKey: "test-key" });

    expect(tools.map((tool) => tool.definition.name)).toEqual(
      MONITOR_DEFINITIONS.map((definition) => definition.name),
    );
  });
});

describe("firecrawl_monitor_create handler", () => {
  it("creates a monitor", async () => {
    const fetcher = makeFetchStub({ success: true, id: "mon_1" });
    const runner = createToolRunner(
      createMonitorTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_monitor_create",
        arguments: {
          config: { name: "Homepage watcher", url: "https://example.com" },
        },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/monitor");
    expect(call?.[1].method).toBe("POST");
    expect(JSON.parse(String(call?.[1].body))).toEqual({
      name: "Homepage watcher",
      url: "https://example.com",
    });
  });

  it("requires config", async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(
      createMonitorTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      { id: "call_1", name: "firecrawl_monitor_create", arguments: {} },
      new AbortController().signal,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("config must be an object");
  });
});

describe("firecrawl_monitor_get handler", () => {
  it("gets a monitor by id", async () => {
    const fetcher = makeFetchStub({ success: true, id: "mon_1" });
    const runner = createToolRunner(
      createMonitorTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_monitor_get",
        arguments: { id: "mon_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/monitor/mon_1");
    expect(call?.[1].method).toBe("GET");
  });
});

describe("firecrawl_monitor_update handler", () => {
  it("patches a monitor", async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(
      createMonitorTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_monitor_update",
        arguments: { id: "mon_1", config: { name: "Updated name" } },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/monitor/mon_1");
    expect(call?.[1].method).toBe("PATCH");
  });
});

describe("firecrawl_monitor_delete handler", () => {
  it("deletes a monitor", async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(
      createMonitorTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_monitor_delete",
        arguments: { id: "mon_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/monitor/mon_1");
    expect(call?.[1].method).toBe("DELETE");
  });
});

describe("firecrawl_monitor_run handler", () => {
  it("runs a monitor check", async () => {
    const fetcher = makeFetchStub({ success: true });
    const runner = createToolRunner(
      createMonitorTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_monitor_run",
        arguments: { id: "mon_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/monitor/mon_1/run");
    expect(call?.[1].method).toBe("POST");
  });
});

describe("firecrawl_monitor_check handler", () => {
  it("lists monitor checks", async () => {
    const fetcher = makeFetchStub({ success: true, checks: [] });
    const runner = createToolRunner(
      createMonitorTools({ apiKey: "test-key", fetcher }),
    );

    const result = await runner.run(
      {
        id: "call_1",
        name: "firecrawl_monitor_check",
        arguments: { id: "mon_1" },
      },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.firecrawl.dev/v2/monitor/mon_1/checks");
    expect(call?.[1].method).toBe("GET");
  });
});
