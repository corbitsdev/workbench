// ChatWorkspace carries the shell's single col2 toggle through its
// headerLeading slot: first in the channel header when a channel is active,
// and in a bare header while channels load — so chat never strands the
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

const channelWire = {
  id: "ch_1",
  title: "Growth",
  kind: "channel",
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
  if (url.includes("/chat/channels?kind=channel")) {
    return Promise.resolve(jsonResponse({ items: [channelWire] }));
  }
  if (url.includes("/chat/channels?kind=chat")) {
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

  test("channels loading renders a bare header that carries the toggle", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(() => {})) as typeof fetch;
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <ChatWorkspace
            tenant={{ kind: "ready", tenantId: "tnt_1" }}
            channelId="ch_1"
            headerLeading={leading}
          />
        </TestQueryProvider>,
      );
    });
    const header = container.querySelector(".chat-channel-header");
    if (header === null) throw new Error("bare header not rendered");
    expect(
      header.querySelector('button[aria-label="Toggle sidebar"]'),
    ).not.toBeNull();
  });

  test("an active channel renders the toggle first in the channel header", async () => {
    globalThis.fetch = routeFetch as typeof fetch;
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <ChatWorkspace
            tenant={{ kind: "ready", tenantId: "tnt_1" }}
            channelId="ch_1"
            headerLeading={leading}
          />
        </TestQueryProvider>,
      );
    });
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.innerHTML.includes("chat-channel-title")) break;
    }

    const header = container.querySelector(".chat-channel-header");
    if (header === null) throw new Error("channel header not rendered");
    expect(header.textContent).toContain("Growth");
    const toggle = header.querySelector('button[aria-label="Toggle sidebar"]');
    if (toggle === null) throw new Error("toggle not in the channel header");
    expect(header.firstElementChild).toBe(toggle);
  });
});
