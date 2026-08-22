import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { WorkbenchList } from "../src/shell/workbench-list";
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

function stubFetch(data: { readonly needsYou?: readonly unknown[] }): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/top-level-runs"))
      return Promise.resolve(json({ data: [], nextCursor: null }));
    if (path.includes("/approvals/needs-you"))
      return Promise.resolve(json({ items: data.needsYou ?? [] }));
    if (path.includes("/agent-definitions/visible"))
      return Promise.resolve(json({ definitions: [] }));
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
          <WorkbenchList path="/w" onNavigate={onNavigate} />
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

describe("WorkbenchList — needs-you signal", () => {
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
