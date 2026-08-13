// Composition tests for `ChatWorkspace`'s settings-surface wiring: it
// mounts against a registered DOM (see dom-setup.ts) because these prove
// real effect-driven sequencing — the two-step "channels resolve, then the
// settings surface renders" load a direct `/c/:id/settings` URL drives —
// which static markup rendering cannot exercise.
//
// Stubs `global.fetch` the same way test/api.test.ts does (never
// `mock.module`, which would replace `../src/api` for every test file in
// this run, not just this one) and a minimal `EventSource` stand-in so the
// channel stream's connect attempt has something to call.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

class StubEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {}
}

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

const CHANNEL_WIRE = {
  id: "ch_1",
  title: "Launch Planning",
  kind: "channel",
  pinned: false,
  participants: [],
};

function stubFetch() {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/channels\?kind=channel$/.test(path)) {
      return json({ items: [CHANNEL_WIRE] });
    }
    if (/\/chat\/channels\?kind=chat$/.test(path)) return json({ items: [] });
    if (/\/chat\/channels\/[^/]+\/threads$/.test(path)) {
      return json({ rootThreadId: "", items: [] });
    }
    if (/\/chat\/channels\/[^/]+\/messages/.test(path)) {
      return json({ items: [] });
    }
    if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
      return json({
        ...CHANNEL_WIRE,
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
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
  act(() => {
    root.render(createElement(ChatWorkspace, props));
  });
  return {
    container,
    settle: () => act(() => sleep(30)),
    unmount: () => root.unmount(),
  };
}

describe("ChatWorkspace settings surface", () => {
  test("a direct /c/:id/settings URL renders the settings surface once channels resolve", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      settingsOpen: true,
    });
    await harness.settle();

    expect(
      harness.container.querySelector(".channel-settings-stage"),
    ).not.toBeNull();
    expect(harness.container.textContent).toContain("Launch Planning");
    harness.unmount();
  });

  test("settingsOpen for a channel id absent from the resolved list falls back to the ordinary chat view and corrects the URL", async () => {
    stubFetch();
    const settingsOpenChanges: boolean[] = [];
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_missing",
      settingsOpen: true,
      onSettingsOpenChange: (open: boolean) => settingsOpenChanges.push(open),
    });
    await harness.settle();

    expect(
      harness.container.querySelector(".channel-settings-stage"),
    ).toBeNull();
    expect(harness.container.querySelector(".chat-main")).not.toBeNull();
    expect(settingsOpenChanges).toEqual([false]);
    harness.unmount();
  });
});
