// Screen-level proof for the Routines page's "Available" section
// (CL-7073): lists catalog workflows the bench hasn't added yet, and
// shows a missing-required-connection reason with a link to Plugins.
// CL-8160 deleted the hub's on-demand catalog-blocks deploy route
// (`apps/hub/src/catalog-blocks/*`) — the section is read-only until a
// deploy path lands on stock rails.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { AvailableCatalogWorkflowsSection } from "../src/pages/routines-page";
import { NavigationProvider } from "../src/navigation";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const codeReview = {
  assetName: "code-review",
  displayName: "Code review",
  description: "Reviews a pull request and posts one review back on it.",
  requiredConnections: ["github"],
  missingConnections: ["github"],
  connectionsSatisfied: false,
};

const echo = {
  assetName: "echo",
  displayName: "Echo",
  description: "Replies with the exact text it received.",
  requiredConnections: [],
  missingConnections: [],
  connectionsSatisfied: true,
};

async function render(
  fetchImpl: typeof fetch,
): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  await act(async () => {
    root.render(
      <TestQueryProvider>
        <NavigationProvider navigate={noop}>
          {createElement(AvailableCatalogWorkflowsSection, {
            tenantId: "tnt_1",
          })}
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  (container as unknown as { __realFetch: typeof fetch }).__realFetch =
    realFetch;
  return { container, root };
}

function restoreFetch(container: HTMLDivElement, root: Root): void {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = (
    container as unknown as { __realFetch: typeof fetch }
  ).__realFetch;
  window.localStorage.clear();
}

describe("AvailableCatalogWorkflowsSection", () => {
  test("renders every available entry with its display name and description", async () => {
    const { container, root } = await render((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.includes("/workflows/available")) {
        return jsonResponse({ items: [codeReview, echo] });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch);
    try {
      expect(container.textContent).toContain("Code review");
      expect(container.textContent).toContain(
        "Reviews a pull request and posts one review back on it.",
      );
      expect(container.textContent).toContain("Echo");
    } finally {
      restoreFetch(container, root);
    }
  });

  test("shows a missing-connection reason and links to Plugins when a required connection is absent", async () => {
    const { container, root } = await render((async (
      input: RequestInfo | URL,
    ) => {
      const url = String(input);
      if (url.includes("/workflows/available")) {
        return jsonResponse({ items: [codeReview] });
      }
      return Promise.reject(new Error(`unrouted fetch: ${url}`));
    }) as typeof fetch);
    try {
      expect(container.textContent).toContain("Connect GitHub first.");
      const link = container.querySelector("a");
      expect(link?.getAttribute("href")).toBe("/plugins");
    } finally {
      restoreFetch(container, root);
    }
  });
});
