// The "shown once" webhook-secret panel: confirms it renders the hook URL
// and secret exactly once, mirrors the copy the Routines page's webhook
// panel already commits to, and only renders the sample-payload block
// when a caller supplies one.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WebhookSecretPanel } from "../src/webhook-secret-panel";

function mount(element: React.ReactElement): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

let mounted: { container: HTMLDivElement; root: Root } | null = null;
afterEach(() => {
  if (mounted !== null) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
});

describe("WebhookSecretPanel", () => {
  test("shows the hook URL, the secret, and a shown-once warning", () => {
    mounted = mount(
      <WebhookSecretPanel
        url="https://bench.example.com/api/webhooks/wht_1"
        secret="sec_abc123"
      />,
    );
    expect(document.body.textContent).toContain(
      "https://bench.example.com/api/webhooks/wht_1",
    );
    expect(document.body.textContent).toContain("sec_abc123");
    expect(document.body.textContent).toContain("shown once");
  });

  test("omits the sample payload block when none is given", () => {
    mounted = mount(
      <WebhookSecretPanel url="https://x/api/webhooks/wht_1" secret="s" />,
    );
    expect(document.body.textContent).not.toContain("Example payload");
  });

  test("renders the sample payload when given", () => {
    mounted = mount(
      <WebhookSecretPanel
        url="https://x/api/webhooks/wht_1"
        secret="s"
        samplePayload={JSON.stringify({ event: "call.completed" })}
      />,
    );
    expect(document.body.textContent).toContain("call.completed");
    expect(document.body.textContent).toContain("Example payload");
  });

  test("copy buttons write the URL and secret to the clipboard", async () => {
    const written: string[] = [];
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          written.push(value);
          return Promise.resolve();
        },
      },
    });
    try {
      mounted = mount(
        <WebhookSecretPanel
          url="https://x/api/webhooks/wht_1"
          secret="sec_xyz"
        />,
      );
      const copyButtons = [...document.body.querySelectorAll("button")].filter(
        (button) => button.textContent?.includes("Copy"),
      );
      expect(copyButtons.length).toBe(2);
      act(() => copyButtons[0]?.click());
      act(() => copyButtons[1]?.click());
      await act(() => Promise.resolve());
      expect(written).toEqual(["https://x/api/webhooks/wht_1", "sec_xyz"]);
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});
