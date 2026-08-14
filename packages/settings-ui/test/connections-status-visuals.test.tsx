// A not-configured OAuth connector (no operator-registered app yet) and a
// not-connected api-key connector are both "nothing to show" states, but
// they mean different things — one needs an operator, the other just needs
// a click. They must not render as the same neutral chip.

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

describe("Connections status chips", () => {
  test("an unconfigured OAuth connector reads distinctly from a not-connected api-key one", async () => {
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
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<ConnectionsSection tenantId="ten_1" />);
      });
      await settle();

      expect(container.textContent).toContain("Needs setup");
      expect(container.textContent).toContain("Not connected");

      const badges = [...container.querySelectorAll('[data-slot="badge"]')];
      const needsSetupBadge = badges.find(
        (badge) => badge.textContent === "Needs setup",
      );
      const notConnectedBadge = badges.find(
        (badge) => badge.textContent === "Not connected",
      );
      expect(needsSetupBadge).not.toBeUndefined();
      expect(notConnectedBadge).not.toBeUndefined();
      expect(needsSetupBadge?.className).not.toBe(notConnectedBadge?.className);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
