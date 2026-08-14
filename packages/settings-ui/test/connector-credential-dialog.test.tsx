// A passed test result is only valid for the exact string it tested — any
// keystroke after that invalidates it (canSave already goes false), but
// nothing told a person why Save just grayed out. Confirms the quiet
// inline nudge appears, and stays out of the way until it's needed.

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

function mount(): { container: HTMLDivElement; root: Root } {
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
        onConnected={() => undefined}
      />,
    );
  });
  return { container, root };
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 10)));

describe("ConnectorCredentialDialog key-changed nudge", () => {
  test("shows quiet copy once an edit invalidates a passed test", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const { container, root } = mount();
    try {
      const input = document.body.querySelector("input[type=password]");
      expect(input).not.toBeNull();
      act(() => typeInto(input as HTMLInputElement, "sk-original"));

      const testButton = [...document.body.querySelectorAll("button")].find(
        (button) => button.textContent === "Test connection",
      );
      act(() => {
        testButton?.click();
      });
      await settle();
      expect(document.body.textContent).toContain("Key works.");

      act(() => typeInto(input as HTMLInputElement, "sk-original-edited"));

      expect(document.body.textContent).toContain(
        "Key changed — test it again before saving",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
