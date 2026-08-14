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
