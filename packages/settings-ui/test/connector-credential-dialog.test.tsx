// CL-6377: one action, not test-then-save — pasting a key and pressing
// the single Connect button is the whole flow. There is no separate
// client-driven "test" round-trip before it: `/complete` itself proves
// the key against the connector's own probe and only stores it once that
// probe accepts, so a rejected key never gets sealed.
//
// CL-6793: Ollama's field is a base URL, not a sealed secret — the same
// dialog swaps copy when `credentialInputKind` is `"url"`.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { ConnectorDescriptor } from "@workbench/connections/registry";

import { ConnectorCredentialDialog } from "../src/connections-section";
import { SETTINGS_STRINGS } from "../src/strings";

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

const ollamaDescriptor: ConnectorDescriptor = {
  id: "ollama",
  displayName: "Ollama",
  authKind: "api-key",
  docsUrl: "https://example.com/docs",
  credentialPlugin: "http",
  feedsTools: [],
  credentialInputKind: "url",
  credentialPlaceholder: "http://localhost:11434",
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

function mount(
  onConnected: () => void = () => undefined,
  next: ConnectorDescriptor = descriptor,
): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ConnectorCredentialDialog
        descriptor={next}
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
      candidate.textContent === "Connect" ||
      candidate.textContent === "Connecting…",
  );
  expect(button).not.toBeUndefined();
  return button as HTMLButtonElement;
}

describe("ConnectorCredentialDialog", () => {
  test("offers exactly one primary action — no separate Test and Save buttons, and no test-key copy anywhere", () => {
    const { container, root } = mount();
    try {
      const labels = [...document.body.querySelectorAll("button")].map(
        (button) => button.textContent,
      );
      expect(labels).not.toContain("Test connection");
      expect(labels).not.toContain("Save");
      expect(labels).toContain("Connect");
      expect(document.body.textContent).not.toContain("Test key");
      expect(document.body.textContent).not.toContain("test the key");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("connecting is a single round-trip to /complete — no separate /credential/test call", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      calls.push(path);
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

      expect(calls).toEqual(["/api/tenants/ten_1/connections/linear/complete"]);
      expect(connected).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a rejected key surfaces the probe's own message inline, from that same call", async () => {
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
      expect(calls).toEqual(["/api/tenants/ten_1/connections/linear/complete"]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("Ollama connect dialog copy matches a URL / base-address field, not a sealed secret key", () => {
    const { container, root } = mount(() => undefined, ollamaDescriptor);
    try {
      const body = document.body.textContent ?? "";
      expect(body).toContain(SETTINGS_STRINGS.connectionsUrlLabel);
      expect(body).toContain(SETTINGS_STRINGS.connectionsDialogUrlDescription);
      expect(body).not.toContain(SETTINGS_STRINGS.connectionsDialogDescription);
      expect(body).not.toContain(SETTINGS_STRINGS.connectionsKeyLabel);
      expect(body).not.toContain("Sealed on save");
      expect(body).not.toContain("this key is never shown again");
      expect(body).not.toContain("A bad key never gets saved");
      expect(document.body.querySelector("input[type=password]")).toBeNull();
      expect(
        (document.body.querySelector("input[type=text]") as HTMLInputElement)
          .placeholder,
      ).toBe("http://localhost:11434");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("Sealed-key wording is reserved for actual secret fields", () => {
    const { container, root } = mount();
    try {
      const body = document.body.textContent ?? "";
      expect(body).toContain(SETTINGS_STRINGS.connectionsDialogDescription);
      expect(body).toContain(SETTINGS_STRINGS.connectionsKeyLabel);
      expect(body).toContain("Sealed on save");
      expect(body).not.toContain(
        SETTINGS_STRINGS.connectionsDialogUrlDescription,
      );
      expect(document.body.querySelector("input[type=password]")).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
