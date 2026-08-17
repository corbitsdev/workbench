// The channel header's combined who's-active stack: every agent
// participant on the channel plus every human currently reflected in live
// presence, overlapping with a title tooltip, collapsing anything past
// TEAM_AVATAR_STACK_LIMIT into a "+N" chip. Mirrors
// presence-stack.test.tsx's stub-fetch/mount harness.

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
}

afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
  StubEventSource.instances = [];
});

function stubFetch(channelWire: { participants: { address: string; handle: string }[] }) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/channels\?kind=channel$/.test(path)) {
      return json({
        items: [
          {
            id: "ch_1",
            title: "Launch Planning",
            kind: "channel",
            pinned: false,
            participants: channelWire.participants,
          },
        ],
      });
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

function presenceMember(id: string, name: string) {
  return { principalId: id, displayName: name, color: "hsl(10 65% 45%)" };
}

describe("channel header team avatar stack", () => {
  test("renders every agent participant and every live human", async () => {
    stubFetch({
      participants: [
        { address: "myra@agents.example", handle: "Myra" },
        { address: "prn_bob", handle: "Bob" },
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      presenceMembers: [presenceMember("prn_alice", "Alice")],
    });
    await harness.settle();

    const stack = harness.container.querySelector(".chat-team-stack");
    expect(stack).not.toBeNull();
    const agentAvatars = harness.container.querySelectorAll(
      '.chat-presence-avatar[data-agent="true"]',
    );
    expect(agentAvatars).toHaveLength(1);
    const agentAvatar = agentAvatars[0] as HTMLElement;
    expect(agentAvatar.title).toBe("Myra");
    expect(agentAvatar.textContent).toBe("M");
    const presenceAvatars = harness.container.querySelectorAll(
      ".chat-presence-avatar:not([data-agent])",
    );
    expect(presenceAvatars).toHaveLength(1);
    expect((presenceAvatars[0] as HTMLElement).title).toBe("Alice");
    expect(
      harness.container.querySelector(".chat-team-stack-overflow"),
    ).toBeNull();
    harness.unmount();
  });

  test("collapses anything past the limit into a +N chip", async () => {
    const presenceMembers = ["Alice", "Bob", "Carla", "Dana", "Eve", "Finn"].map(
      (name, index) => presenceMember(`prn_${index}`, name),
    );
    stubFetch({
      participants: [{ address: "myra@agents.example", handle: "Myra" }],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      channelId: "ch_1",
      presenceMembers,
    });
    await harness.settle();

    // 1 agent + 6 humans = 7 total, limit is 6, so one overflows.
    const overflow = harness.container.querySelector(
      ".chat-team-stack-overflow",
    );
    expect(overflow).not.toBeNull();
    expect(overflow?.textContent).toBe("+1");
    harness.unmount();
  });
});
