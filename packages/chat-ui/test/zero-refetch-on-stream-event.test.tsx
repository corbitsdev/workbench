// CL-6328's own bar (§6/1.2): once a workbench's feed has hydrated, a
// stream event never triggers a refetch — it applies straight into the
// cache. This suite mounts `ChatWorkspace` for real, counts every `fetch`
// call, and proves the count stays flat across a `chat.message` stream
// event and across a composer send whose confirm echoes back over the
// stream.

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
  readyState = 1;
  listeners = new Map<string, (message: MessageEvent) => void>();

  constructor(readonly url: string) {
    StubEventSource.instances.push(this);
  }

  addEventListener(
    eventType: string,
    listener: (message: MessageEvent) => void,
  ) {
    this.listeners.set(eventType, listener);
  }

  emit(eventType: string, data: unknown) {
    this.listeners.get(eventType)?.({
      data: JSON.stringify(data),
    } as MessageEvent);
  }

  close() {
    this.readyState = 2;
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

// The feed's own reads (CL-6328's target): a `GET` against messages,
// threads, or pins. `PUT .../read-state` is a legitimate side effect of a
// new message landing (the read cursor advancing) — not a refetch of data
// the stream event already carried — so it's tracked separately and never
// counted against the §6/1.2 bar.
let feedRefetchCount = 0;
const sentBodies: unknown[] = [];

function stubFetch() {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  feedRefetchCount = 0;
  sentBodies.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    if (
      method === "GET" &&
      /\/chat\/workbenches\/[^/]+\/(messages|threads|pins)(\?|$)/.test(path)
    ) {
      feedRefetchCount += 1;
    }
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
        const body = JSON.parse(String(init.body)) as { clientId?: string };
        sentBodies.push(body);
        return json({
          id: "msg_confirmed",
          createdAt: "2026-01-01T00:00:05.000Z",
          clientId: body.clientId,
        });
      }
      return json({ items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/pins$/.test(path)) return json([]);
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path))
      return json({ items: [] });
    if (
      /\/chat\/workbenches\/[^/]+\/presence$/.test(path) &&
      init?.method === "POST"
    ) {
      return json({});
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

const { ChatWorkspace } = await import("../src/chat-workspace");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(props: Parameters<typeof ChatWorkspace>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  act(() => {
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
  };
}

function firstStream(): StubEventSource {
  const instance = StubEventSource.instances[0];
  if (instance === undefined) throw new Error("no stream connected");
  return instance;
}

describe("zero refetches on a stream event, post-hydration (CL-6328 §6/1.2)", () => {
  test("a streamed chat.message renders with no fetch call beyond mount-hydration", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();

    const feedRefetchCountAfterHydration = feedRefetchCount;
    expect(feedRefetchCountAfterHydration).toBeGreaterThan(0);

    act(() => {
      firstStream().emit("chat.message", {
        id: "m_streamed",
        workbenchId: "ch_1",
        createdAt: "2026-01-01T00:00:10.000Z",
        threadId: null,
        sender: { name: "Bob", address: "prn_bob@acme.example" },
        parts: [{ kind: "text", text: "streamed in live" }],
      });
    });
    await harness.settle();

    expect(feedRefetchCount).toBe(feedRefetchCountAfterHydration);
    expect(harness.container.textContent).toContain("streamed in live");
    harness.unmount();
  });

  test("a composer send's own confirm echo (matching clientId) never doubles the bubble or triggers a refetch", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
      currentUser: { principalId: "prn_alice" },
    });
    await harness.settle();

    const textarea = harness.container.querySelector(
      ".chat-composer-input",
    ) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(textarea, "hi there");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendButton = harness.container.querySelector(
      'button[aria-label="Send"]',
    ) as HTMLButtonElement;
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await sleep(30);
    });

    expect(sentBodies).toHaveLength(1);
    const sentClientId = (sentBodies[0] as { clientId: string }).clientId;
    expect(typeof sentClientId).toBe("string");
    const feedRefetchCountAfterSend = feedRefetchCount;

    // The workbench's own broadcast of this send, echoed back on its
    // stream — same `clientId` the POST response carried.
    act(() => {
      firstStream().emit("chat.message", {
        id: "msg_confirmed",
        workbenchId: "ch_1",
        createdAt: "2026-01-01T00:00:05.000Z",
        threadId: null,
        clientId: sentClientId,
        sender: { name: null, address: "prn_alice@pending.local" },
        parts: [{ kind: "text", text: "hi there" }],
      });
    });
    await harness.settle();

    // No refetch triggered by the echo, and no duplicate bubble.
    expect(feedRefetchCount).toBe(feedRefetchCountAfterSend);
    const bubbles = harness.container.querySelectorAll(
      '[data-own="true"] .chat-bubble',
    );
    expect(bubbles).toHaveLength(1);
    harness.unmount();
  });
});
