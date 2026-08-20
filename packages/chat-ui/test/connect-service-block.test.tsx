// DOM tests for the generic service connect card (CL-6393) — the
// preset-driven generalization of the GitHub card. Mounts
// `ConnectServiceBlockView` directly, the same standalone-mount shape
// `connect-github-block.test.tsx` uses; the container + actions-port
// round-trip is covered by `connect-service-flow.test.tsx`. Covers: the
// one-click OAuth arm, the one-click keyless arm, the key-paste arm
// (open, error, submit), and the connected arm.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ConnectServiceCardProps } from "../src/blocks/connect-service-block";
import { ConnectServiceBlockView } from "../src/blocks/connect-service-block";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mountElement(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

async function mount(props: ConnectServiceCardProps) {
  return mountElement(<ConnectServiceBlockView {...props} />);
}

function typeInto(element: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  if (match === undefined) throw new Error(`no button "${text}"`);
  return match;
}

const REASON = "Connect Gmail so I can send this for you.";

describe("ConnectServiceBlockView oauth arm", () => {
  test("renders the reason and a single connect button", async () => {
    let connected = 0;
    const host = await mount({
      kind: "disconnected",
      displayName: "Gmail",
      reason: REASON,
      affordance: "oauth",
      onConnect: () => {
        connected += 1;
      },
      onSubmitKey: () => Promise.resolve({ ok: true }),
    });
    expect(host.textContent).toContain("Connect Gmail");
    expect(host.textContent).toContain(REASON);
    buttonByText(host, "Connect Gmail").click();
    expect(connected).toBe(1);
    expect(host.querySelector("input")).toBeNull();
  });
});

describe("ConnectServiceBlockView keyless arm", () => {
  test("renders one click and no key field", async () => {
    let connected = 0;
    const host = await mount({
      kind: "disconnected",
      displayName: "Exa",
      reason: "Connect Exa so I can research this for you.",
      affordance: "keyless",
      onConnect: () => {
        connected += 1;
      },
      onSubmitKey: () => Promise.resolve({ ok: true }),
    });
    buttonByText(host, "Connect Exa").click();
    expect(connected).toBe(1);
    expect(host.querySelector("input")).toBeNull();
  });
});

describe("ConnectServiceBlockView key-paste arm", () => {
  test("opens the key field on connect and submits the pasted key", async () => {
    const submitted: string[] = [];
    const host = await mount({
      kind: "disconnected",
      displayName: "Linear",
      reason: "Connect Linear so I can file this for you.",
      affordance: "api-key",
      onConnect: () => undefined,
      onSubmitKey: (key) => {
        submitted.push(key);
        return Promise.resolve({ ok: true });
      },
    });
    await act(async () => {
      buttonByText(host, "Connect Linear").click();
    });
    const field = host.querySelector("input");
    if (field === null) throw new Error("no key field");
    expect(field.type).toBe("password");
    await act(async () => {
      typeInto(field, "lin_api_123");
    });
    await act(async () => {
      buttonByText(host, "Connect").click();
    });
    expect(submitted).toEqual(["lin_api_123"]);
  });

  test("shows a rejected key inline without closing the field", async () => {
    const host = await mount({
      kind: "disconnected",
      displayName: "Linear",
      reason: "Connect Linear so I can file this for you.",
      affordance: "api-key",
      onConnect: () => undefined,
      onSubmitKey: () =>
        Promise.resolve({ ok: false, message: "That key was rejected." }),
    });
    await act(async () => {
      buttonByText(host, "Connect Linear").click();
    });
    const field = host.querySelector("input");
    if (field === null) throw new Error("no key field");
    await act(async () => {
      typeInto(field, "bad-key");
    });
    await act(async () => {
      buttonByText(host, "Connect").click();
    });
    expect(host.textContent).toContain("That key was rejected.");
    expect(host.querySelector("input")).not.toBeNull();
  });
});

describe("ConnectServiceBlockView connected arm", () => {
  test("renders the connected confirmation and no actions", async () => {
    const host = await mount({
      kind: "connected",
      displayName: "Gmail",
    });
    expect(host.textContent).toContain("Gmail connected");
    expect(host.querySelector("input")).toBeNull();
  });
});
