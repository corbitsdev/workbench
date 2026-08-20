// AI Providers is inference-only. Tool-bearing connectors belong in Plugins,
// including GitHub, so the settings route must never render one here.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ConnectionsSection } from "../src/connections-section";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function mockFetch() {
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/tenants/ten_1/credentials") {
      return json({ data: [], nextCursor: null });
    }
    if (url === "/api/tenants/ten_1/providers") {
      return json({ data: [], nextCursor: null });
    }
    if (url === "/api/tenants/ten_1/connections/oauth-configured") {
      return json({});
    }
    if (url === "/api/tenants/ten_1/models") {
      return json([]);
    }
    if (url === "/api/tenants/ten_1/catalog/offerings") {
      return json({ data: [], nextCursor: null });
    }
    if (url === "/api/tenants/ten_1/routines") {
      return json({ items: [] });
    }
    if (url.startsWith("/api/tenants/ten_1/workflows/definitions?")) {
      return json({ data: [], nextCursor: null });
    }
    if (url === "/api/tenants/ten_1/webhook-triggers") {
      return json({ items: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("AI provider scope", () => {
  test("never renders tool-bearing third-party connectors", async () => {
    mockFetch();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<ConnectionsSection tenantId="ten_1" />);
      });
      await settle();

      const cards = [...container.querySelectorAll(".settings-connection-row")];
      const githubCard = cards.find((card) =>
        card.textContent?.includes("GitHub"),
      );
      expect(githubCard).toBeUndefined();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
