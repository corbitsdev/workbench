// The channel header's live who's-here stack (CL-5958): a plain-data
// `presenceMembers` prop, distinct from the static participants list —
// omitted entirely, nothing renders; supplied, one avatar per member,
// colored per its server-assigned color. Mirrors chat-workspace.test.tsx's
// stub-fetch/mount harness.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

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
}

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  StubEventSource.instances = [];
});

const CHANNEL_WIRE = {
  id: "ch_1",
  title: "Launch Planning",
  kind: "channel",
  pinned: false,
  participants: [] as { address: string; handle: string }[],
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
    if (/\/chat\/channels\/[^/]+\/messages/.test(path))
      return json({ items: [] });
    if (/\/chat\/channels\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/channels\/[^/]+\/invitable$/.test(path))
      return json({ items: [] });
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

describe("channel header presence stack", () => {
  test("renders nothing when presenceMembers is omitted", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
    });
    await harness.settle();

    expect(harness.container.querySelector(".chat-presence-stack")).toBeNull();
    harness.unmount();
  });

  test("renders one colored avatar per live member", async () => {
    stubFetch();
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      presenceMembers: [
        {
          principalId: "prn_alice",
          displayName: "Alice",
          color: "hsl(10 65% 45%)",
        },
        {
          principalId: "prn_bob",
          displayName: "Bob",
          color: "hsl(200 65% 45%)",
        },
      ],
    });
    await harness.settle();

    const avatars = harness.container.querySelectorAll(".chat-presence-avatar");
    expect(avatars).toHaveLength(2);
    expect((avatars[0] as HTMLElement).title).toBe("Alice");
    expect((avatars[1] as HTMLElement).title).toBe("Bob");
    harness.unmount();
  });
});
