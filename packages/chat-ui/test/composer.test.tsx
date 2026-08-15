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
