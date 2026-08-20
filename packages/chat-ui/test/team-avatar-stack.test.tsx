// The workbench header's combined who's-active stack: every agent
// participant on the workbench plus every human currently reflected in live
// presence (CL-6328: the workbench's own `chat.presence.snapshot` stream
// event, not a host-supplied prop), overlapping with a title tooltip,
// collapsing anything past TEAM_AVATAR_STACK_LIMIT into a "+N" chip.
// Mirrors presence-stack.test.tsx's stub-fetch/mount harness.

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

function stubFetch(workbenchWire: {
  participants: { address: string; handle: string }[];
}) {
  globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (/\/chat\/workbenches\?kind=workbench$/.test(path)) {
      return json({
        items: [
          {
            id: "ch_1",
            title: "Launch Planning",
            kind: "workbench",
            pinned: false,
            participants: workbenchWire.participants,
          },
        ],
      });
    }
    if (/\/chat\/workbenches\?kind=chat$/.test(path))
      return json({ items: [] });
    if (/\/chat\/workbenches\/[^/]+\/threads$/.test(path)) {
      return json({ rootThreadId: "", items: [] });
    }
    if (/\/chat\/workbenches\/[^/]+\/messages/.test(path))
      return json({ items: [] });
    if (/\/chat\/workbenches\/[^/]+\/read-state$/.test(path)) return json({});
    if (/\/chat\/workbenches\/[^/]+\/invitable$/.test(path))
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

function firstStream(): StubEventSource {
  const instance = StubEventSource.instances[0];
  if (instance === undefined) throw new Error("no stream connected");
  return instance;
}

/** A human participant whose bare address (no `@`, so `isAgentAddress`
 * reads it as human) IS its own principal id — this is what lets the
 * presence roster's bare `principalId` resolve back to a display name
 * (`typingLabel`), the same lookup `chat.typing` already relies on. */
function humanParticipant(principalId: string, handle: string) {
  return { address: principalId, handle };
}

describe("workbench header team avatar stack", () => {
  test("renders every agent participant and every live human", async () => {
    stubFetch({
      participants: [
        { address: "myra@agents.example", handle: "Myra" },
        humanParticipant("prn_alice", "Alice"),
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    act(() => {
      firstStream().emit("chat.presence.snapshot", {
        members: [
          { principalId: "prn_alice", lastActiveAt: "2026-01-01T00:00:00Z" },
        ],
      });
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
    const humanNames = ["Alice", "Bob", "Carla", "Dana", "Eve", "Finn"];
    const humanParticipants = humanNames.map((name, index) =>
      humanParticipant(`prn_${index}`, name),
    );
    stubFetch({
      participants: [
        { address: "myra@agents.example", handle: "Myra" },
        ...humanParticipants,
      ],
    });
    const harness = mount({
      tenant: { kind: "ready", tenantId: "tnt_1" },
      workbenchId: "ch_1",
    });
    await harness.settle();
    act(() => {
      firstStream().emit("chat.presence.snapshot", {
        members: humanNames.map((_, index) => ({
          principalId: `prn_${index}`,
          lastActiveAt: "2026-01-01T00:00:00Z",
        })),
      });
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
