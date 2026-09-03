// CL-6487: `connections-section.tsx`'s visibility/focus refresh effect
// re-reads connections on `visibilitychange`/`focus` and every 30s while
// visible, gated on a non-null `tenantId`, with a microtask guard
// collapsing a same-tick visibilitychange+focus pair into a single reload.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ConnectionsSection } from "../src/connections-section";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function renderSection(tenantId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(<ConnectionsSection tenantId={tenantId} />);
  });
  return { container, root };
}

function stubFetch(onCredentialsFetch: () => void): typeof fetch {
  return (async (url: string) => {
    if (url === "/api/tenants/ten_1/credentials") {
      onCredentialsFetch();
      return json({ data: [], nextCursor: null });
    }
    if (url === "/api/tenants/ten_1/providers")
      return json({ data: [], nextCursor: null });
    if (url === "/api/tenants/ten_1/connections/oauth-configured")
      return json({});
    if (url === "/api/tenants/ten_1/models") return json([]);
    if (url === "/api/tenants/ten_1/catalog/offerings")
      return json({ data: [], nextCursor: null });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("ConnectionsSection refresh-on-visibility effect", () => {
  test("becoming visible/focused in the same tick triggers exactly one reload, does nothing while tenantId is null, and cleans up its listeners/interval on unmount", async () => {
    let credentialsCalls = 0;
    globalThis.fetch = stubFetch(() => {
      credentialsCalls += 1;
    });

    const documentAddSpy = spyOn(document, "addEventListener");
    const documentRemoveSpy = spyOn(document, "removeEventListener");
    const windowAddSpy = spyOn(window, "addEventListener");
    const windowRemoveSpy = spyOn(window, "removeEventListener");

    const { container, root } = renderSection("ten_1");
    try {
      await settle();
      expect(credentialsCalls).toBeGreaterThan(0);
      const callsAfterMount = credentialsCalls;

      const visibilityHandler = documentAddSpy.mock.calls.find(
        (call) => call[0] === "visibilitychange",
      )?.[1] as EventListener;
      const focusHandler = windowAddSpy.mock.calls.find(
        (call) => call[0] === "focus",
      )?.[1] as EventListener;
      expect(visibilityHandler).not.toBeUndefined();
      expect(focusHandler).not.toBeUndefined();

      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      act(() => {
        visibilityHandler(new Event("visibilitychange"));
        focusHandler(new Event("focus"));
      });
      await settle();

      expect(credentialsCalls).toBe(callsAfterMount + 1);

      act(() => root.unmount());

      expect(documentRemoveSpy).toHaveBeenCalledWith(
        "visibilitychange",
        visibilityHandler,
      );
      expect(windowRemoveSpy).toHaveBeenCalledWith("focus", focusHandler);
    } finally {
      container.remove();
      documentAddSpy.mockRestore();
      documentRemoveSpy.mockRestore();
      windowAddSpy.mockRestore();
      windowRemoveSpy.mockRestore();
    }
  });

  test("registers no visibility/focus listener while tenantId is null", async () => {
    globalThis.fetch = stubFetch(() => undefined);

    const documentAddSpy = spyOn(document, "addEventListener");
    const windowAddSpy = spyOn(window, "addEventListener");

    const { container, root } = renderSection(null);
    try {
      await settle();

      expect(
        documentAddSpy.mock.calls.some(
          (call) => call[0] === "visibilitychange",
        ),
      ).toBe(false);
      expect(windowAddSpy.mock.calls.some((call) => call[0] === "focus")).toBe(
        false,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      documentAddSpy.mockRestore();
      windowAddSpy.mockRestore();
    }
  });
});
