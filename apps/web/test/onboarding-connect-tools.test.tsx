// The "Connect your tools" step's advance button must never gate progress,
// but its label should stop reading "Skip for now" the moment a connector
// actually connects this session — otherwise a wizard that just helped you
// connect Linear still tells you you're skipping something.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

const actualSettingsUi = await import("@corbits/settings-ui");

let fireConnected: (() => void) | null = null;

mock.module("@corbits/settings-ui", () => ({
  ...actualSettingsUi,
  ConnectorCardGrid: (props: { readonly onConnected?: () => void }) => {
    fireConnected = () => props.onConnected?.();
    return null;
  },
}));

const { ConnectToolsGrid } = await import("../src/pages/onboarding-page");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  fireConnected = null;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function renderGrid(container: HTMLElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(<ConnectToolsGrid tenantId="ten_1" onDone={() => undefined} />);
  });
  return root;
}

describe("ConnectToolsGrid advance button", () => {
  test("reads Skip for now until a connector actually connects, then Continue", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === "/api/tenants/ten_1/credentials") {
        return json({ data: [], nextCursor: null });
      }
      if (url === "/api/tenants/ten_1/providers") {
        return json({ data: [], nextCursor: null });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = renderGrid(container);
    try {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const button = () =>
        Array.from(container.querySelectorAll("button")).find((el) =>
          ["Skip for now", "Continue"].includes(el.textContent ?? ""),
        );

      expect(button()?.textContent).toBe("Skip for now");

      act(() => {
        fireConnected?.();
      });

      expect(button()?.textContent).toBe("Continue");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
