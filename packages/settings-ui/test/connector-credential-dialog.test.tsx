// CL-6077: one primary action, not test-then-save — the wizard's own
// onboarding step already combines "test key and run my first routine"
// into a single button, and this dialog now matches that: pasting a key
// and pressing the one primary action tests it for real and only stores
// it once that test passes. A rejected key never reaches
// `completeConnectorCredential`, so nothing gets sealed on a bad key.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ConnectorDescriptor } from "@workbench/connections/registry";

import { ConnectorCredentialDialog } from "../src/connections-section";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const descriptor: ConnectorDescriptor = {
  id: "linear",
  displayName: "Linear",
  authKind: "api-key",
  docsUrl: "https://example.com/docs",
  credentialPlugin: "http",
  feedsTools: ["linear"],
};

const nativeSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value",
)?.set;
if (nativeSetter === undefined) {
  throw new Error("HTMLInputElement.prototype.value has no native setter");
}

function typeInto(input: HTMLInputElement, value: string) {
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function mount(onConnected: () => void = () => undefined): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ConnectorCredentialDialog
        descriptor={descriptor}
        mode="connect"
        tenantId="ten_1"
        onClose={() => undefined}
        onConnected={onConnected}
      />,
    );
  });
  return { container, root };
}

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function primaryButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent === "Test key and connect" ||
      candidate.textContent === "Testing and connecting…",
  );
  expect(button).not.toBeUndefined();
  return button as HTMLButtonElement;
}

describe("ConnectorCredentialDialog", () => {
  test("offers exactly one primary action — no separate Test and Save buttons", () => {
    const { container, root } = mount();
    try {
      const labels = [...document.body.querySelectorAll("button")].map(
        (button) => button.textContent,
      );
      expect(labels).not.toContain("Test connection");
      expect(labels).not.toContain("Save");
      expect(labels).toContain("Test key and connect");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a passing test stores the key and reports success, in one click", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      if (path.endsWith("/credential/test")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ credentialId: "cred_1", status: "active" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    let connected = false;
    const { container, root } = mount(() => {
      connected = true;
    });
    try {
      const input = document.body.querySelector("input[type=password]");
      act(() => typeInto(input as HTMLInputElement, "sk-good"));
      act(() => primaryButton().click());
      await settle();

      expect(calls.some((path) => path.endsWith("/credential/test"))).toBe(
        true,
      );
      expect(calls.some((path) => path.endsWith("/complete"))).toBe(true);
      expect(connected).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a failing test shows the rejection and never calls complete", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_credential",
            message: "That key doesn't work.",
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      const input = document.body.querySelector("input[type=password]");
      act(() => typeInto(input as HTMLInputElement, "sk-bad"));
      act(() => primaryButton().click());
      await settle();

      expect(document.body.textContent).toContain("That key doesn't work.");
      expect(calls.some((path) => path.endsWith("/complete"))).toBe(false);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
