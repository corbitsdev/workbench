// ChatWorkspace carries the shell's single col2 toggle through its
// headerLeading slot: first in the workbench header when a workbench is active,
// and in a bare header while workbenches load — so chat never strands the
// toggle behind its own loading states. Lives here (not packages/chat-ui)
// because these branches only resolve under a DOM with effects.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ChatWorkspace } from "@corbits/chat-ui";

import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

class StubEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const workbenchWire = {
  id: "ch_1",
  title: "Growth",
  kind: "workbench",
  pinned: false,
  participants: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function routeFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("/chat/workbenches?kind=workbench")) {
    return Promise.resolve(jsonResponse({ items: [workbenchWire] }));
  }
  if (url.includes("/chat/workbenches?kind=chat")) {
    return Promise.resolve(jsonResponse({ items: [] }));
  }
  if (url.includes("/threads")) {
    return Promise.resolve(
      jsonResponse({
        rootThreadId: "th_1",
        items: [
          {
            id: "th_1",
            kind: "root",
            parentMessageId: null,
            runRef: null,
            title: null,
            createdAt: "2026-01-15T12:00:00.000Z",
          },
        ],
      }),
    );
  }
  if (url.includes("/messages")) {
    return Promise.resolve(jsonResponse({ items: [] }));
  }
  return Promise.resolve(jsonResponse({}));
}

const leading = <button type="button" aria-label="Toggle sidebar" />;

describe("ChatWorkspace headerLeading", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    globalThis.EventSource = realEventSource;
  });

  test("workbenches loading renders a bare header that carries the toggle", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(() => {})) as typeof fetch;
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <ChatWorkspace
            tenant={{ kind: "ready", tenantId: "tnt_1" }}
            workbenchId="ch_1"
            headerLeading={leading}
          />
        </TestQueryProvider>,
      );
    });
    const header = container.querySelector(".chat-workbench-header");
    if (header === null) throw new Error("bare header not rendered");
    expect(
      header.querySelector('button[aria-label="Toggle sidebar"]'),
    ).not.toBeNull();
  });

  test("an active workbench renders the toggle first in the workbench header", async () => {
    globalThis.fetch = routeFetch as typeof fetch;
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <ChatWorkspace
            tenant={{ kind: "ready", tenantId: "tnt_1" }}
            workbenchId="ch_1"
            headerLeading={leading}
          />
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("chat-workbench-title")) break;
    }

    const header = container.querySelector(".chat-workbench-header");
    if (header === null) throw new Error("workbench header not rendered");
    expect(header.textContent).toContain("Growth");
    const toggle = header.querySelector('button[aria-label="Toggle sidebar"]');
    if (toggle === null) throw new Error("toggle not in the workbench header");
    expect(header.firstElementChild).toBe(toggle);
  });
});
