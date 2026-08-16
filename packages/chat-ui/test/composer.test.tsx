// The composer's Send button, in-flight: standardized on the same
// label-swap/disabled pattern the create-agent and invite-agent dialogs
// already use (CL-6019) — previously the icon-only button gave no visible
// signal that a send was in progress beyond being disabled.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { Composer } from "../src/composer";
import type { ComposerHandle } from "../src/composer";

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

function mount(onSend: () => Promise<boolean>) {
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
        onOpenRoutines: () => undefined,
        onCreateRoutineInSpace: () => undefined,
      }),
    );
  });
  return container;
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

describe("Composer send button", () => {
  test("shows a Sending… label and stays disabled while the send promise is unresolved", async () => {
    let resolveSend: (value: boolean) => void = () => undefined;
    const onSend = () =>
      new Promise<boolean>((resolve) => {
        resolveSend = resolve;
      });
    mount(onSend);

    const textarea = container?.querySelector("textarea");
    if (textarea === null || textarea === undefined) {
      throw new Error("composer textarea not found");
    }
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        globalThis.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "hello there");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    expect(sendButton().getAttribute("aria-label")).toBe("Send");

    act(() => {
      sendButton().click();
    });
    await settle();

    expect(sendButton().getAttribute("aria-label")).toBe("Sending…");
    expect(sendButton().hasAttribute("disabled")).toBe(true);

    await act(async () => {
      resolveSend(true);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(sendButton().getAttribute("aria-label")).toBe("Send");
  });
});

function hint(): Element | null {
  return container?.querySelector(".chat-composer-hint") ?? null;
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

describe("Composer keyboard hint", () => {
  test("stays hidden until the textarea is focused with a non-empty draft", async () => {
    mount(() => Promise.resolve(true));
    expect(hint()).toBeNull();

    act(() => {
      textarea().focus();
    });
    await settle();
    expect(hint()).toBeNull();

    typeInto(textarea(), "hello");
    await settle();
    expect(hint()?.textContent).toBe("Enter to send");

    act(() => {
      textarea().blur();
    });
    await settle();
    expect(hint()).toBeNull();
  });

  test("hides again once the draft is cleared while still focused", async () => {
    mount(() => Promise.resolve(true));
    act(() => {
      textarea().focus();
    });
    typeInto(textarea(), "hi");
    await settle();
    expect(hint()).not.toBeNull();

    typeInto(textarea(), "");
    await settle();
    expect(hint()).toBeNull();
  });
});
