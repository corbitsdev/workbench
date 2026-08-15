// CL-6075: the People section lists humans only. A tenant with one real
// member and several machine principals (one per folded-run launch, kind
// "workflow") must render exactly the human row — never the machine rows
// flooding the human-management surface.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { PeopleSection } from "../src/people-section";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function workflowPrincipal(n: number) {
  return {
    id: `prn_workflow_${n}`,
    tenantId: "tnt_1",
    kind: "workflow" as const,
    refId: `run_${n}`,
    displayName: `Workflow (run_${n}@alice-0ufqkxuy.localhost)`,
    status: "active" as const,
    roles: [],
    ...timestamps,
  };
}

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PeopleSection tenantId="tnt_1" />);
  });
  return { container, root };
}

describe("PeopleSection", () => {
  test("excludes workflow-kind rows and renders only the human member", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/principals") {
        return json(200, {
          data: [
            workflowPrincipal(1),
            workflowPrincipal(2),
            workflowPrincipal(3),
            {
              id: "prn_human_1",
              tenantId: "tnt_1",
              kind: "user",
              refId: "user_1",
              displayName: "Alice Anderson",
              status: "active",
              roles: [],
              ...timestamps,
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.textContent).toContain("Alice Anderson");
      expect(container.textContent).not.toContain("Workflow");
      expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("shows the empty state when only machine principals exist", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/tnt_1/principals") {
        return json(200, {
          data: [workflowPrincipal(1), workflowPrincipal(2)],
          nextCursor: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      await settle();
      expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
