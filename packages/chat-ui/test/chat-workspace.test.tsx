// Composition tests for `ChatWorkspace`'s settings-surface wiring: it
// mounts against a registered DOM (see dom-setup.ts) because these prove
// real effect-driven sequencing — the two-step "workbenches resolve, then the
// settings surface renders" load a direct `/c/:id/settings` URL drives —
// which static markup rendering cannot exercise.
//
// Stubs `global.fetch` the same way test/api.test.ts does (never
// `mock.module`, which would replace `../src/api` for every test file in
// this run, not just this one) and a minimal `EventSource` stand-in so the
// workbench stream's connect attempt has something to call.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

class StubEventSource {
  static instances: StubEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  StubEventSource.instances = [];
});

const WORKBENCH_WIRE = {
  id: "ch_1",
  title: "Launch Planning",
  kind: "workbench",
  pinned: false,
  participants: [] as { address: string; handle: string }[],
};

type WorkbenchAgentFixture = {
  readonly address: string;
  readonly handle: string;
  readonly definitionId: string;
  readonly definitionAssetId: string;
  readonly displayName: string;
};

function stubFetch(
  sentMessages?: unknown[],
  workbench: typeof WORKBENCH_WIRE = WORKBENCH_WIRE,
  options: {
    readonly turnsFail?: boolean;
    readonly workbenchAgents?: readonly WorkbenchAgentFixture[];
  } = {},
) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
      return json({ items: [workbench] });
    }
    if (/\/chat\/workbenches\?kind=chat$/.test(path)) return json({ items: [] });
    if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
      return json({ rootThreadId: "", items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
      if (init?.method === "POST") {
        sentMessages?.push(JSON.parse(String(init.body)));
        return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
      }
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/agents$/.test(path)) {
      return json({ items: options.workbenchAgents ?? [] });
    }
    // CL-6380 catch-up: empty list = nothing running. Returning this by
    // default keeps agent-participant mounts from treating an unstubbed
    // turns path as a resume failure (CL-6833).
    if (/\/chat\/workbenches\/[^/]+\/turns(?:\/|$|\?)/.test(path)) {
      if (options.turnsFail === true) {
        return new Response(JSON.stringify({ error: "turns unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
      return json({
        ...workbench,
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    if (/\/mailbox\/me\/threads/.test(path)) {
      return json({ threads: [] });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

const { ChatWorkspace } = await import("../src/chat-workspace");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `root.render` only starts the query client's fetches; their promises
// settle on later microtasks that a synchronous `act(() => {...})` never
// waits for, so the state updates those fetches drive would otherwise land
// outside any `act` call. Awaiting an async `act` here flushes that
// microtask queue before `mount` (and every `test(...)` that awaits it)
// hands control back to the caller.
async function mount(props: Parameters<typeof ChatWorkspace>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ChatWorkspace, props),
      ),
    );
  });
  return {
    container,
    settle: () => act(() => sleep(30)),
    unmount: () => root.unmount(),
    rerender: (nextProps: Parameters<typeof ChatWorkspace>[0]) =>
      act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(ChatWorkspace, nextProps),
          ),
        );
      }),
  };
}

describe("chat error copy never leaks a raw API path", () => {
  test("a genuine load failure renders plain-language copy, never a raw /api/ path or bare status code", async () => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      // The feed reads via the mailbox now (CL-8174 slice 2b) — a 500
      // here is what this test's "no raw path/status leaks" copy check
      // actually exercises.
      if (/\/mailbox\/me\/threads/.test(path)) {
        return new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    expect(harness.container.textContent).toContain("Couldn't load messages");
    expect(harness.container.textContent).not.toContain("/api/");
    expect(harness.container.textContent).not.toContain("500");
    harness.unmount();
  });
});

describe("Invite control visibility (CL-6781)", () => {
  test("hides Invite agent when the invitable listing succeeds empty", async () => {
    stubFetch();
    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(harness.container.textContent).not.toContain("Invite agent");
    harness.unmount();
  });

  test("shows Invite agent once at least one definition is invitable", async () => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
        return json({ items: [WORKBENCH_WIRE] });
      }
      if (/\/chat\/workbenches\?kind=chat$/.test(path)) return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
        return json({ rootThreadId: "", items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/messages/.test(path)) {
        if (init?.method === "POST") {
          return json({ id: "msg_new", createdAt: "2026-01-01T00:00:00.000Z" });
        }
        return json({ items: [] });
      }
      if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
      if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path)) {
        return json({
          items: [{ id: "wfd_echo", name: "echo", description: "Echo" }],
        });
      }
      if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path)) return json({ items: [] });
      if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
        return json({
          ...WORKBENCH_WIRE,
          settings: {},
          contextWindow: { value: 20, source: "inherit" },
        });
      }
      if (/\/chat\/bench\/settings$/.test(path)) {
        return json({ settings: {}, contextWindow: 20 });
      }
      if (/\/mailbox\/me\/threads/.test(path)) {
        return json({ threads: [] });
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }) as typeof fetch;

    const harness = await mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    await harness.settle();

    expect(harness.container.textContent).toContain("Invite agent");
    harness.unmount();
  });
});
