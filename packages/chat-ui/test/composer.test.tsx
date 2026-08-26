// The composer's Send button, in-flight: standardized on the same
// label-swap/disabled pattern the create-agent and invite-agent dialogs
// already use (CL-6019) — previously the icon-only button gave no visible
// signal that a send was in progress beyond being disabled.

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

function mountWithMentions(
  onSend: (payload: ComposerSendPayload) => Promise<boolean>,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<ComposerHandle>();
  act(() => {
    root?.render(
      createElement(Composer, {
        ref,
        agents: [],
        participants: [
          { address: "researcher@agents.example", handle: "researcher" },
        ],
        members: [{ id: "prn_bob", displayName: "Bob" }],
        invitableAgents: [
          { id: "wfd_echo", name: "echo", description: "Echo" },
        ],
        onSend,
        onInviteAgent: () => undefined,
        onOpenAgentsSettings: () => undefined,
        onCreateRoutineInSpace: () => undefined,
      }),
    );
  });
  return container;
}

describe("Composer mention popover — Agents and People (CL-5879)", () => {
  test("renders Agents and People sections with name and @handle", async () => {
    mountWithMentions(() => Promise.resolve(true));
    typeInto(textarea(), "@");
    await settle();

    const options = Array.from(
      container?.querySelectorAll(".chat-mention-option") ?? [],
    );
    const rows = options.map((option) => ({
      name: option.querySelector(".chat-mention-name")?.textContent,
      handle: option.querySelector(".chat-mention-handle")?.textContent,
      section: option.getAttribute("data-mention-section"),
    }));
    expect(rows).toEqual([
      { name: "Researcher", handle: "@researcher", section: "agents" },
      { name: "echo", handle: "@echo", section: "agents" },
      { name: "Bob", handle: "@bob", section: "people" },
    ]);

    const groupLabels = Array.from(
      container?.querySelectorAll(".chat-mention-group-label") ?? [],
    ).map((label) => label.textContent);
    expect(groupLabels).toEqual(["Agents", "People"]);
  });

  test("picking a not-yet-participant candidate inserts the mention and marks invite intent on send", async () => {
    const sent: { payload: ComposerSendPayload | null } = { payload: null };
    mountWithMentions((payload) => {
      sent.payload = payload;
      return Promise.resolve(true);
    });
    typeInto(textarea(), "@bo");
    await settle();

    const options = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".chat-mention-option") ??
        [],
    );
    const bobOption = options.find(
      (option) =>
        option.querySelector(".chat-mention-handle")?.textContent === "@bob",
    );
    if (bobOption === undefined) throw new Error("bob option not found");
    act(() => {
      bobOption.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(textarea().value).toBe("@bob ");

    act(() => {
      sendButton().click();
    });
    await settle();

    if (sent.payload === null) throw new Error("payload not sent");
    expect(sent.payload.invite).toEqual([
      { kind: "person", principalId: "prn_bob", name: "Bob" },
    ]);
  });

  test("picking an existing-participant candidate marks no invite intent", async () => {
    const sent: { payload: ComposerSendPayload | null } = { payload: null };
    mountWithMentions((payload) => {
      sent.payload = payload;
      return Promise.resolve(true);
    });
    typeInto(textarea(), "@res");
    await settle();

    const options = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".chat-mention-option") ??
        [],
    );
    const researcherOption = options.find(
      (option) =>
        option.querySelector(".chat-mention-handle")?.textContent ===
        "@researcher",
    );
    if (researcherOption === undefined) {
      throw new Error("researcher option not found");
    }
    act(() => {
      researcherOption.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    act(() => {
      sendButton().click();
    });
    await settle();

    if (sent.payload === null) throw new Error("payload not sent");
    expect(sent.payload.invite).toBeUndefined();
  });
});

// The hint used to mount/unmount with its condition, which added and
// removed a line from the composer's box on every focus/blur and
// keystroke. It is now always in the DOM with a reserved height; only
// `data-visible` (and the opacity/visibility CSS it drives) toggles, so
// asserting on that attribute — never on presence/absence — is the
// honest way to test the new mechanism (CL-6250).
describe("Composer keyboard hint", () => {
  test("is always mounted and stays visibility-hidden until focused with a non-empty draft", async () => {
    mount(() => Promise.resolve(true));
    expect(hint()).not.toBeNull();
    expect(hint()?.getAttribute("data-visible")).toBe("false");

    act(() => {
      textarea().focus();
    });
    await settle();
    expect(hint()?.getAttribute("data-visible")).toBe("false");

    typeInto(textarea(), "hello");
    await settle();
    expect(hint()?.getAttribute("data-visible")).toBe("true");
    expect(hint()?.textContent).toBe("Enter to send");

    act(() => {
      textarea().blur();
    });
    await settle();
    expect(hint()?.getAttribute("data-visible")).toBe("false");
  });

  test("hides again once the draft is cleared while still focused, without unmounting", async () => {
    mount(() => Promise.resolve(true));
    act(() => {
      textarea().focus();
    });
    typeInto(textarea(), "hi");
    await settle();
    expect(hint()?.getAttribute("data-visible")).toBe("true");

    typeInto(textarea(), "");
    await settle();
    expect(hint()).not.toBeNull();
    expect(hint()?.getAttribute("data-visible")).toBe("false");
  });
});

describe("Composer growth containment (CL-6250)", () => {
  test("the textarea carries the max-height/overflow class and keeps applying its measured inline height", async () => {
    mount(() => Promise.resolve(true));
    expect(textarea().className).toContain("chat-composer-input");

    typeInto(textarea(), "line one\nline two\nline three");
    await settle();
    // The auto-grow effect still measures and writes an inline height on
    // every change — the CSS transition added for CL-6250 smooths that
    // write, it does not replace it.
    expect(textarea().style.height.endsWith("px")).toBe(true);
  });
});

describe("Composer popover entrance (CL-6250)", () => {
  test("the slash popover carries the entrance class", async () => {
    mount(() => Promise.resolve(true));
    typeInto(textarea(), "/");
    await settle();
    const popover = container?.querySelector(".chat-mention-popover");
    expect(popover?.classList.contains("chat-popover-enter")).toBe(true);
  });

  test("the mention popover carries the entrance class", async () => {
    mountWithMentions(() => Promise.resolve(true));
    typeInto(textarea(), "@");
    await settle();
    const popover = container?.querySelector(".chat-mention-popover");
    expect(popover?.classList.contains("chat-popover-enter")).toBe(true);
  });
});

describe("Composer hit targets (CL-6250)", () => {
  test("attach and send buttons carry the extended-hit-area class", () => {
    mount(() => Promise.resolve(true));
    const buttons = container?.querySelectorAll(".chat-composer-icon-button");
    expect(buttons?.length).toBe(2);
  });
});

describe("Composer mention bring-in load error (CL-6839)", () => {
  function mountWithBringInError(bringInLoadError: string) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          agents: [],
          participants: [],
          members: [],
          invitableAgents: [],
          bringInLoadError,
          onSend: () => Promise.resolve(true),
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });
  }

  test("shows the load error instead of an honest empty 'No matches' list", async () => {
    mountWithBringInError("Couldn't load people and agents to bring in");
    typeInto(textarea(), "@");
    await settle();

    const empty = container?.querySelector(".chat-mention-empty");
    expect(empty?.getAttribute("role")).toBe("alert");
    expect(empty?.textContent).toBe(
      "Couldn't load people and agents to bring in",
    );
    expect(container?.textContent).not.toContain("No matches");
  });

  test("keeps in-workbench matches visible and still surfaces the bring-in error", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          agents: [],
          participants: [
            { address: "researcher@agents.example", handle: "researcher" },
          ],
          members: [],
          invitableAgents: [],
          bringInLoadError: "Couldn't load agents to bring in",
          onSend: () => Promise.resolve(true),
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });
    typeInto(textarea(), "@");
    await settle();

    const alert = container?.querySelector('.chat-mention-empty[role="alert"]');
    expect(alert?.textContent).toBe("Couldn't load agents to bring in");
    const handles = Array.from(
      container?.querySelectorAll(".chat-mention-handle") ?? [],
    ).map((node) => node.textContent);
    expect(handles).toEqual(["@researcher"]);
  });
});

describe("ComposerHandle.setText", () => {
  test("replaces the existing draft and focuses with the caret at the end", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const ref = createRef<ComposerHandle>();
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          onSend: () => Promise.resolve(true),
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    typeInto(textarea(), "unsent draft");
    await settle();
    expect(textarea().value).toBe("unsent draft");

    await act(async () => {
      ref.current?.setText("previous prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });

    expect(textarea().value).toBe("previous prompt");
    expect(document.activeElement).toBe(textarea());
    expect(textarea().selectionStart).toBe("previous prompt".length);
    expect(textarea().selectionEnd).toBe("previous prompt".length);
  });

  test("Enter after setText sends the copied prompt instead of running a slash command", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const ref = createRef<ComposerHandle>();
    const sent: ComposerSendPayload[] = [];
    let inviteAgentCalls = 0;
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => {
            inviteAgentCalls += 1;
          },
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    typeInto(textarea(), "/");
    await settle();
    expect(container?.querySelector(".chat-mention-popover")).not.toBeNull();

    await act(async () => {
      ref.current?.setText("copied prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    await settle();

    expect(textarea().value).toBe("copied prompt");
    expect(container?.querySelector(".chat-mention-popover")).toBeNull();

    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();

    expect(inviteAgentCalls).toBe(0);
    expect(sent).toEqual([{ text: "copied prompt", attachments: [] }]);
  });

  test("Send after setText does not carry leftover bring-in invite intent", async () => {
    const sent: { payload: ComposerSendPayload | null } = { payload: null };
    const ref = createRef<ComposerHandle>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          participants: [
            { address: "researcher@agents.example", handle: "researcher" },
          ],
          members: [{ id: "prn_bob", displayName: "Bob" }],
          invitableAgents: [
            { id: "wfd_echo", name: "echo", description: "Echo" },
          ],
          onSend: (payload) => {
            sent.payload = payload;
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    typeInto(textarea(), "@bo");
    await settle();
    const options = Array.from(
      container?.querySelectorAll<HTMLButtonElement>(".chat-mention-option") ??
        [],
    );
    const bobOption = options.find(
      (option) =>
        option.querySelector(".chat-mention-handle")?.textContent === "@bob",
    );
    if (bobOption === undefined) throw new Error("bob option not found");
    act(() => {
      bobOption.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(textarea().value).toBe("@bob ");

    await act(async () => {
      ref.current?.setText("copied prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    await settle();

    act(() => {
      sendButton().click();
    });
    await settle();

    if (sent.payload === null) throw new Error("payload not sent");
    expect(sent.payload.text).toBe("copied prompt");
    expect(sent.payload.invite).toBeUndefined();
  });

  test("Send after setText does not carry leftover attachments", async () => {
    const sent: ComposerSendPayload[] = [];
    const ref = createRef<ComposerHandle>();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(Composer, {
          ref,
          agents: [],
          onSend: (payload) => {
            sent.push(payload);
            return Promise.resolve(true);
          },
          onInviteAgent: () => undefined,
          onOpenAgentsSettings: () => undefined,
          onCreateRoutineInSpace: () => undefined,
        }),
      );
    });

    const fileInput = container.querySelector<HTMLInputElement>(
      ".chat-composer-file-input",
    );
    if (fileInput === null) throw new Error("file input not found");

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: {
        0: file,
        length: 1,
        item: (index: number) => (index === 0 ? file : null),
        [Symbol.iterator]: function* () {
          yield file;
        },
      },
    });
    act(() => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    await settle();
    expect(container.querySelector(".chat-composer-attachments")).not.toBeNull();

    await act(async () => {
      ref.current?.setText("copied prompt");
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });
    await settle();

    expect(container.querySelector(".chat-composer-attachments")).toBeNull();

    act(() => {
      sendButton().click();
    });
    await settle();

    expect(sent).toEqual([{ text: "copied prompt", attachments: [] }]);
  });
});
