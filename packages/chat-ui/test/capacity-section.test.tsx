// CL-6117: the "run this workbench on its own dedicated capacity" toggle,
// rehomed from settings-ui's unregistered bench section (CL-6096) into the
// channel settings surface's own Capacity section. Covers the real
// fetch/save wiring — load, optimistic flip, revert on failure, and the
// disabled-with-hint state when the provisioner isn't available.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { CapacitySection } from "../src/channel-settings/capacity-section";

const TENANT_ID = "tnt_flow";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(options: {
  enabled?: boolean;
  provisionerAvailable?: boolean;
  putResponder?: () => Response;
}): void {
  const {
    enabled = false,
    provisionerAvailable = true,
    putResponder,
  } = options;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    if (path === `/api/tenants/${TENANT_ID}/sidecar-placement`) {
      if (init?.method === "PUT") {
        return putResponder
          ? putResponder()
          : Response.json({ enabled: true, provisionerAvailable });
      }
      return Response.json({ enabled, provisionerAvailable });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
}

async function mount(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<CapacitySection tenantId={TENANT_ID} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { container, root };
}

describe("CapacitySection", () => {
  test("states its outcome in plain terms, never infra jargon", async () => {
    stubFetch({});
    const { container, root } = await mount();
    try {
      const text = document.body.textContent ?? "";
      expect(text).toContain(
        "This workbench's agents run on their own dedicated capacity.",
      );
      expect(text.toLowerCase()).not.toContain("sidecar");
      expect(text.toLowerCase()).not.toContain("provisioner");
      expect(text.toLowerCase()).not.toContain("tenant");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("flips the switch optimistically before the save resolves", async () => {
    let resolvePut: ((response: Response) => void) | undefined;
    const putPromise = new Promise<Response>((resolve) => {
      resolvePut = resolve;
    });
    stubFetch({ putResponder: () => putPromise as unknown as Response });

    const { container, root } = await mount();
    try {
      const toggle =
        document.body.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(toggle?.getAttribute("aria-checked")).toBe("false");

      act(() => toggle?.click());
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
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("reverts the switch and shows an error when the save fails", async () => {
    stubFetch({ putResponder: () => new Response("nope", { status: 500 }) });

    const { container, root } = await mount();
    try {
      const toggle =
        document.body.querySelector<HTMLButtonElement>('[role="switch"]');
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

  test("disables the switch and shows an honest hint when unavailable", async () => {
    stubFetch({ provisionerAvailable: false });

    const { container, root } = await mount();
    try {
      const toggle =
        document.body.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(toggle?.disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Not available on this server yet — ask your operator to enable isolated capacity.",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
