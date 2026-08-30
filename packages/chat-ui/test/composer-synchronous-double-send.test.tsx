// CL-7198: the composer's send guard used to test the `sending` *state*
// variable, which `performSend` only sets after the click/keydown handler
// that started it has already returned. Two triggers landing in the same
// synchronous tick (e.g. a stray double dispatch of the send action) both
// read `sending === false` and both post — this proves a second trigger in
// the same tick is turned away regardless of state timing.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { Composer } from "../src/composer";
import type { ComposerHandle, ComposerSendPayload } from "../src/composer";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function mount(onSend: (payload: ComposerSendPayload) => Promise<boolean>) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<ComposerHandle>();
  act(() => {
    root?.render(
      createElement(Composer, {
        ref,
        agents: [],
        onSend,
        onInviteAgent: () => undefined,
        onOpenAgentsSettings: () => undefined,
        onCreateRoutineInSpace: () => undefined,
      }),
    );
  });
  return container;
}

function textarea(): HTMLTextAreaElement {
  const element = container?.querySelector("textarea");
  if (element === null || element === undefined) {
    throw new Error("composer textarea not found");
  }
  return element;
}

function typeInto(element: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    '[aria-label^="Send"]',
  );
  if (button === null || button === undefined) {
    throw new Error("send button not found");
  }
  return button;
}

describe("Composer synchronous double-send guard (CL-7198)", () => {
  test("two clicks in the same tick post exactly one send", async () => {
    let sendCount = 0;
    const payloads: ComposerSendPayload[] = [];
    mount((payload) => {
      sendCount += 1;
      payloads.push(payload);
      return Promise.resolve(true);
    });

    typeInto(textarea(), "hello there");
    await settle();

    act(() => {
      sendButton().click();
      sendButton().click();
    });
    await settle();

    expect(sendCount).toBe(1);
    expect(payloads).toEqual([{ text: "hello there", attachments: [] }]);
  });
});
