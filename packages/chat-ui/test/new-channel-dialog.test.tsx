// DOM-mounted render tests for `NewChannelDialog`'s counterpart picker:
// both the "Agents" and "People" tabs render when a host injects
// `listMembers`, and the People tab is absent entirely when it doesn't
// (the pre-existing, agent-only dialog). Needs a real DOM (see
// dom-setup.ts) — Radix's `Dialog.Portal` renders nothing under
// `renderToStaticMarkup` (see components.test.tsx's note on the same
// dialog's pure functions).
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { NewChannelDialog } from "../src/new-channel-dialog";
import type { PersonOption } from "../src/new-channel-dialog";
import type { InvitableDefinition } from "../src/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubInvitableDefinitions(items: readonly InvitableDefinition[]) {
  globalThis.fetch = (async (_input: RequestInfo | URL) =>
    new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof NewChannelDialog>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(NewChannelDialog, props));
  });
  return container;
}

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

describe("NewChannelDialog guided stepper", () => {
  test("opens on the kind step and shows stepper chrome when no initial kind is given", async () => {
    stubInvitableDefinitions([]);
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
    });
    await settle();

    expect(document.body.querySelector(".dialog-stepper")).not.toBeNull();
    expect(document.body.textContent).toContain("Step 1 of 2");
    expect(document.body.textContent).toContain("Kind");
    expect(
      document.body.querySelector(
        '[data-testid="new-chat-counterpart-picker"]',
      ),
    ).toBeNull();
  });

  test("Next advances from the kind step to the details step for a channel", async () => {
    stubInvitableDefinitions([]);
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
    });
    await settle();

    const nextButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    );
    act(() => {
      nextButton?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Step 2 of 2");
    expect(document.body.textContent).toContain("Name");
    expect(document.body.textContent).toContain("Purpose");
  });

  test("a channel created with zero typing beyond the kind pick stays disabled until named", async () => {
    stubInvitableDefinitions([]);
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
    });
    await settle();

    const nextButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    );
    act(() => {
      nextButton?.click();
    });
    await settle();

    const createButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Create",
    );
    expect(createButton?.hasAttribute("disabled")).toBe(true);
  });

  test("submitting swaps the Create label to Creating…, matching the create-agent/invite-agent dialogs' pending pattern", async () => {
    stubInvitableDefinitions([]);
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: true,
      initialKind: "channel",
    });
    await settle();

    expect(document.body.textContent).toContain("Creating…");
    const submitButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.getAttribute("type") === "submit",
    );
    expect(submitButton?.textContent).toBe("Creating…");
    expect(submitButton?.hasAttribute("disabled")).toBe(true);
  });

  test("Back returns to the kind step without losing the chosen kind", async () => {
    stubInvitableDefinitions([]);
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
    });
    await settle();

    const chatCard = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Chat"),
    );
    act(() => {
      chatCard?.click();
    });
    const nextButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    );
    act(() => {
      nextButton?.click();
    });
    await settle();
    expect(document.body.textContent).toContain("Step 2 of 2");

    const backButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Back",
    );
    act(() => {
      backButton?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Step 1 of 2");
    const chatCardAfterBack = [
      ...document.body.querySelectorAll("button"),
    ].find((button) => button.textContent?.includes("Chat"));
    expect(chatCardAfterBack?.getAttribute("aria-pressed")).toBe("true");
  });

  test("a typed purpose is passed to onCreate as the payload's second argument", async () => {
    stubInvitableDefinitions([]);
    let received: [unknown, string | undefined] | undefined;
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: (input, purpose) => {
        received = [input, purpose];
      },
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "channel",
    });
    await settle();

    const nameInput = document.body.querySelector(
      "input",
    ) as HTMLInputElement | null;
    act(() => {
      nameInput?.dispatchEvent(new Event("focus"));
    });
    const textarea = document.body.querySelector("textarea");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "Launch planning");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const nameSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      nameSetter?.call(nameInput, "Launch");
      nameInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const createButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Create",
    );
    act(() => {
      createButton?.click();
    });
    await settle();

    expect(received).toBeDefined();
    expect(received?.[1]).toBe("Launch planning");
  });

  test("an untyped purpose passes undefined to onCreate", async () => {
    stubInvitableDefinitions([]);
    let received: [unknown, string | undefined] | undefined;
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: (input, purpose) => {
        received = [input, purpose];
      },
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "channel",
    });
    await settle();

    const nameInput = document.body.querySelector(
      "input",
    ) as HTMLInputElement | null;
    const nameSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      nameSetter?.call(nameInput, "Launch");
      nameInput?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();

    const createButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Create",
    );
    act(() => {
      createButton?.click();
    });
    await settle();

    expect(received).toBeDefined();
    expect(received?.[1]).toBeUndefined();
  });

  test("an initial kind skips the kind step and opens straight on details, with no Back", async () => {
    stubInvitableDefinitions([{ id: "wfd_echo", name: "Echo" }]);
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "channel",
    });
    await settle();

    expect(document.body.textContent).toContain("Step 2 of 2");
    const backButton = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Back",
    );
    expect(backButton).toBeUndefined();
  });

  test("an agent labels by its display description, falling back to the asset name", async () => {
    stubInvitableDefinitions([
      { id: "wfd_assistant", name: "assistant", description: "Myra" },
      { id: "wfd_custom", name: "my-analyst" },
    ]);
    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
    });
    await settle();

    expect(document.body.textContent).toContain("Myra");
    expect(document.body.textContent).not.toContain("assistant");
    expect(document.body.textContent).toContain("my-analyst");
  });
});

describe("NewChannelDialog counterpart picker", () => {
  test("with listMembers injected, a chat offers both an Agents and a People tab", async () => {
    stubInvitableDefinitions([{ id: "wfd_echo", name: "Echo" }]);
    const listMembers = async (): Promise<readonly PersonOption[]> => [
      { id: "prn_bob", displayName: "Bob" },
    ];

    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
      listMembers,
    });
    await settle();

    expect(document.body.textContent).toContain("Agents");
    expect(document.body.textContent).toContain("People");
  });

  test("with no listMembers, only the agent-only picker renders — no People tab at all", async () => {
    stubInvitableDefinitions([{ id: "wfd_echo", name: "Echo" }]);

    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
    });
    await settle();

    expect(
      document.body.querySelector('[data-testid="new-chat-agent-picker"]'),
    ).not.toBeNull();
    expect(document.body.textContent).not.toContain("People");
  });

  test("switching to the People tab renders the fetched member as a radio option", async () => {
    stubInvitableDefinitions([{ id: "wfd_echo", name: "Echo" }]);
    const listMembers = async (): Promise<readonly PersonOption[]> => [
      { id: "prn_bob", displayName: "Bob" },
    ];

    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
      listMembers,
    });
    await settle();

    const peopleTab = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "People",
    );
    expect(peopleTab).toBeDefined();
    act(() => {
      peopleTab?.click();
    });
    await settle();

    expect(
      document.body.querySelector('[data-testid="new-chat-person-option"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Bob");
  });

  test("the current user is excluded from the People tab", async () => {
    stubInvitableDefinitions([]);
    const listMembers = async (): Promise<readonly PersonOption[]> => [
      { id: "prn_alice", displayName: "Alice" },
      { id: "prn_bob", displayName: "Bob" },
    ];

    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
      listMembers,
      currentUserPrincipalId: "prn_alice",
    });
    await settle();

    const peopleTab = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "People",
    );
    act(() => {
      peopleTab?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Bob");
    expect(document.body.textContent).not.toContain("Alice");
  });
});

describe("NewChannelDialog New agent… affordance", () => {
  test("with onRequestNewAgent wired, the agent tab offers a New agent… row", async () => {
    stubInvitableDefinitions([{ id: "wfd_echo", name: "Echo" }]);
    let requested = false;

    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
      onRequestNewAgent: () => {
        requested = true;
      },
    });
    await settle();

    const row = document.body.querySelector(
      '[data-testid="new-chat-create-agent"]',
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("New agent");
    act(() => {
      (row as HTMLButtonElement | null)?.click();
    });
    expect(requested).toBe(true);
  });

  test("absent — not disabled — when the host hasn't wired onRequestNewAgent", async () => {
    stubInvitableDefinitions([{ id: "wfd_echo", name: "Echo" }]);

    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
    });
    await settle();

    expect(
      document.body.querySelector('[data-testid="new-chat-create-agent"]'),
    ).toBeNull();
  });

  test("still offered with listMembers wired (the agent tab inside the People/Agents Tabs)", async () => {
    stubInvitableDefinitions([{ id: "wfd_echo", name: "Echo" }]);
    const listMembers = async (): Promise<readonly PersonOption[]> => [
      { id: "prn_bob", displayName: "Bob" },
    ];

    mount({
      open: true,
      onOpenChange: () => undefined,
      onCreate: () => undefined,
      tenantId: "tnt_1",
      submitting: false,
      initialKind: "chat",
      listMembers,
      onRequestNewAgent: () => undefined,
    });
    await settle();

    expect(
      document.body.querySelector('[data-testid="new-chat-create-agent"]'),
    ).not.toBeNull();
  });
});
