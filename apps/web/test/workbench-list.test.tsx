import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { SidebarSections } from "../src/shell/workbench-list";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const membership = {
  data: [
    {
      principalId: "prn_1",
      tenantId: "tnt_1",
      tenantName: "Corbits Bench",
      tenantSlug: "corbits-bench",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(data: {
  readonly needsYou?: readonly unknown[];
  readonly workbenches?: readonly unknown[];
  readonly chats?: readonly unknown[];
  readonly agents?: readonly unknown[];
  readonly openedChat?: unknown;
}): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/approvals/needs-you"))
      return Promise.resolve(json({ items: data.needsYou ?? [] }));
    if (path.includes("/agent-definitions/visible"))
      return Promise.resolve(json({ definitions: data.agents ?? [] }));
    if (path.includes("/chat/workbenches?kind=workbench"))
      return Promise.resolve(json({ items: data.workbenches ?? [] }));
    if (path.includes("/chat/workbenches?kind=chat"))
      return Promise.resolve(json({ items: data.chats ?? [] }));
    if (path.includes("/chat/workbenches") && init?.method === "POST")
      return Promise.resolve(json(data.openedChat));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

function needsYouItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr_1",
    agentName: "Myra",
    benchName: "Corbits Bench",
    headline: "Merge the checkout fix",
    arguments: {},
    status: "pending",
    createdAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

async function mount(onNavigate: (to: string) => void = () => undefined) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <BenchProvider>
          <SidebarSections path="/w" onNavigate={onNavigate} />
        </BenchProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

describe("SidebarSections", () => {
  const room = {
    id: "ch_room",
    title: "Launch Room",
    kind: "workbench",
    pinned: false,
    participants: [],
  };
  const agentChat = {
    id: "ch_agent",
    title: "Myra",
    kind: "chat",
    definitionId: "wfd_myra",
    pinned: false,
    participants: [],
  };
  const humanDm = {
    id: "ch_human",
    title: "Ada",
    kind: "chat",
    principalId: "prn_ada",
    pinned: false,
    participants: [{ address: "prn_ada", handle: "Ada" }],
  };
  const unopened = {
    id: "wfd_research",
    name: "Research",
    tenantId: "tnt_ancestor",
    tenantName: "Parent Bench",
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  test("renders Agents and Channels without human DMs or duplicate definition rows", async () => {
    stubFetch({
      workbenches: [room],
      chats: [agentChat, humanDm],
      agents: [
        {
          id: "wfd_myra",
          name: "Myra definition",
          tenantId: "tnt_1",
          tenantName: "Corbits Bench",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        unopened,
      ],
    });

    const el = await mount();

    expect(
      [...el.querySelectorAll("h2")].map((node) => node.textContent),
    ).toEqual(["Agents", "Channels"]);
    expect(el.textContent).toContain("Myra");
    expect(el.textContent).toContain("Research");
    expect(el.textContent).toContain("Launch Room");
    expect(el.textContent).not.toContain("Ada");
    expect(el.textContent).not.toContain("Myra definition");
  });

  test("one search filters both sections while retaining both labels", async () => {
    stubFetch({ workbenches: [room], agents: [unopened] });
    const el = await mount();
    const input = el.querySelector<HTMLInputElement>(
      'input[aria-label="Search agents and channels"]',
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (input === null || setter === undefined)
      throw new Error("missing search");

    act(() => {
      setter.call(input, "Research");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(
      [...el.querySelectorAll("h2")].map((node) => node.textContent),
    ).toEqual(["Agents", "Channels"]);
    expect(el.textContent).toContain("Research");
    expect(el.textContent).not.toContain("Launch Room");
  });

  test("opens a standing definition through the agent-DM launcher and navigates", async () => {
    const navigated: string[] = [];
    stubFetch({
      agents: [unopened],
      openedChat: {
        id: "ch_research",
        title: "Research",
        kind: "chat",
        definitionId: unopened.id,
        pinned: false,
        participants: [],
      },
    });
    const el = await mount((to) => navigated.push(to));
    const row = [...el.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Research") === true,
    );
    if (row === undefined) throw new Error("missing definition row");

    await act(async () => row.click());
    for (let i = 0; i < 5; i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }

    expect(navigated).toEqual(["/w/ch_research"]);
  });
});

describe("SidebarSections — needs-you signal", () => {
  test("hides the signal when nothing is pending", async () => {
    stubFetch({ needsYou: [] });
    const el = await mount();
    expect(el.textContent).not.toContain("waiting on you");
  });

  test("shows a filled needs-you chip with the real pending count", async () => {
    stubFetch({
      needsYou: [needsYouItem(), needsYouItem({ id: "apr_2" })],
    });
    const el = await mount();
    expect(el.textContent).toContain("2 waiting on you");
    const chip = el.querySelector('.chip[data-tone="needs-you"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Needs you");
  });
});
