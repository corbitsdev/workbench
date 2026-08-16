// CL-6096: the "keep this workbench's agents on dedicated capacity" switch
// through BenchSection's real fetch/save wiring — the optimistic flip and
// the success feedback (savedAt + toast) that BenchSectionView's own
// pure-component tests can't reach, since those never fetch or save.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchSection } from "../src/bench-section";

const TENANT_ID = "tnt_flow";

const membershipsBody = {
  data: [
    {
      principalId: "prn_1",
      tenantId: TENANT_ID,
      tenantName: "Launch planning",
      tenantSlug: "launch-planning",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

const realFetch = globalThis.fetch;

function stubFetch(putResponder: () => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    if (path === "/api/me/principals") {
      return Response.json(membershipsBody);
    }
    if (path === `/api/tenants/${TENANT_ID}/bench-settings`) {
      return Response.json({ purpose: null, type: null });
    }
    if (path === `/api/tenants/${TENANT_ID}/sidecar-placement`) {
      if (init?.method === "PUT") return putResponder();
      return Response.json({ enabled: false, provisionerAvailable: true });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<BenchSection tenantId={TENANT_ID} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

describe("BenchSection sidecar placement flow", () => {
  test("flips the switch optimistically before the save resolves", async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    const putPromise = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      if (path === "/api/me/principals") return Response.json(membershipsBody);
      if (path === `/api/tenants/${TENANT_ID}/bench-settings`) {
        return Response.json({ purpose: null, type: null });
      }
      if (path === `/api/tenants/${TENANT_ID}/sidecar-placement`) {
        if (init?.method === "PUT") return putPromise;
        return Response.json({ enabled: false, provisionerAvailable: true });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;

    const { container, root } = await mount();
    try {
      const toggle =
        document.body.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(toggle?.getAttribute("aria-checked")).toBe("false");

      act(() => toggle?.click());
      // The flip is synchronous — no need to wait for the PUT to resolve.
      expect(toggle?.getAttribute("aria-checked")).toBe("true");

      resolvePut?.(
        Response.json({ enabled: true, provisionerAvailable: true }),
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(toggle?.getAttribute("aria-checked")).toBe("true");
      expect(document.body.textContent).toMatch(/Saved /);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("reverts the switch and shows an error when the save fails", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));

    const { container, root } = await mount();
    try {
      const toggle =
        document.body.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(toggle?.getAttribute("aria-checked")).toBe("false");

      await act(async () => {
        toggle?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(toggle?.getAttribute("aria-checked")).toBe("false");
      const alert = document.body.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe("Couldn't save this setting. Try again.");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
