import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { WorkbenchList, SIDEBAR_EMPTY_COPY } from "../src/shell/workbench-list";
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

function stubFetch(
  data: {
    readonly pendingApprovals?: readonly unknown[];
    readonly workbenches?: readonly unknown[];
    readonly chats?: readonly unknown[];
  } = {},
): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/approvals"))
      return Promise.resolve(
        json({ data: data.pendingApprovals ?? [], nextCursor: null }),
      );
    if (path.includes("/agent-definitions/visible"))
      return Promise.resolve(json({ definitions: [] }));
    if (path.includes("/chat/workbenches?kind=workbench"))
      return Promise.resolve(json({ items: data.workbenches ?? [] }));
    if (path.includes("/chat/workbenches?kind=chat"))
      return Promise.resolve(json({ items: data.chats ?? [] }));
    return Promise.resolve(json({ items: [] }));
  }) as typeof fetch;
}

function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr_1",
    tenantId: "tnt_1",
    anchorRunId: "run_1",
    runId: "run_1",
    agentAddress: "agent@bench",
    correlationId: "cor_1",
    toolDefinition: { name: "merge_pr", description: "Merge the checkout fix" },
    toolArguments: {},
    scope: null,
    status: "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
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
          <WorkbenchList path="/w" onNavigate={onNavigate} />
        </BenchProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Prefer `shell-ch-row-wrap` over bare `shell-ch-row`: a loading
    // skeleton can paint before the parallel approvals query settles.
    if (
      container.innerHTML.includes("shell-ch-row-wrap") ||
      container.innerHTML.includes("waiting on you")
    ) {
      break;
    }
    // Empty mixed list: keep spinning until the approvals read resolves
    // (chip text) or enough ticks have passed for an empty list to settle.
    if (
      container.innerHTML.includes(SIDEBAR_EMPTY_COPY) &&
      !container.innerHTML.includes("shell-activity-skeleton") &&
      i >= 15
    ) {
      break;
    }
  }
  return container;
}

describe("WorkbenchList — pending-approvals signal", () => {
  test("hides the signal when nothing is pending", async () => {
    stubFetch({ pendingApprovals: [] });
    const el = await mount();
    expect(el.textContent).not.toContain("waiting on you");
  });

  test("shows a filled needs-you chip with the real pending count", async () => {
    stubFetch({
      pendingApprovals: [pendingApproval(), pendingApproval({ id: "apr_2" })],
    });
    const el = await mount();
    expect(el.textContent).toContain("2 waiting on you");
    const chip = el.querySelector('.chip[data-tone="needs-you"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("Needs you");
  });
});

describe("WorkbenchList — pin visibility and order (CL-6657)", () => {
  test("pin glyph floats across the mixed list, never within Agents/Channels sections", async () => {
    stubFetch({
      chats: [
        {
          id: "ch_recent_dm",
          title: "Recent agent",
          kind: "chat",
          pinned: false,
          participants: [],
          lastActivityAt: "2026-08-10T00:00:00.000Z",
        },
        {
          id: "ch_pinned_dm",
          title: "Pinned agent",
          kind: "chat",
          pinned: true,
          participants: [],
          lastActivityAt: "2026-08-02T00:00:00.000Z",
        },
      ],
      workbenches: [
        {
          id: "ch_recent_room",
          title: "Recent channel",
          kind: "workbench",
          pinned: false,
          participants: [],
          lastActivityAt: "2026-08-11T00:00:00.000Z",
        },
        {
          id: "ch_pinned_room",
          title: "Pinned channel",
          kind: "workbench",
          pinned: true,
          participants: [],
          lastActivityAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    const el = await mount();
    expect(el.querySelectorAll(".shell-panel-list-label")).toHaveLength(0);
    expect(el.textContent).not.toContain("Agents");
    expect(el.textContent).not.toContain("Channels");
    const wraps = [...el.querySelectorAll(".shell-ch-row-wrap")];
    expect(wraps.map((row) => row.getAttribute("data-ctx-workbench"))).toEqual([
      "ch_pinned_dm",
      "ch_pinned_room",
      "ch_recent_room",
      "ch_recent_dm",
    ]);
    expect(wraps[0]?.querySelector(".shell-ch-pin")).not.toBeNull();
    expect(wraps[0]?.getAttribute("data-ctx-workbench-pinned")).toBe("true");
    expect(wraps[1]?.querySelector(".shell-ch-pin")).not.toBeNull();
    expect(wraps[1]?.getAttribute("data-ctx-workbench-pinned")).toBe("true");
    expect(wraps[2]?.querySelector(".shell-ch-pin")).toBeNull();
    expect(wraps[3]?.querySelector(".shell-ch-pin")).toBeNull();
  });
});
