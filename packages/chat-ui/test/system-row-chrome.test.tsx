// CL-6739: error, join, connect, and system rows must not expose message
// social chrome (reaction / reply / overflow). Fix-this-connection recovery
// on classified inference failures stays; only the social cluster goes.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import { WorkbenchTimeline } from "../src/timeline";
import type { PinActions, ReactionActions } from "../src/timeline";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

const socialActions = {
  onOpenThread: () => undefined,
  reactionActions: { onToggle: () => undefined } satisfies ReactionActions,
  pinActions: {
    onPin: () => undefined,
    onUnpin: () => undefined,
  } satisfies PinActions,
};

async function mount(
  items: MessageItem[],
  extra: { onFixConnection?: () => void } = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={items}
        onOpenThread={socialActions.onOpenThread}
        reactionActions={socialActions.reactionActions}
        pinActions={socialActions.pinActions}
        {...(extra.onFixConnection !== undefined
          ? { onFixConnection: extra.onFixConnection }
          : {})}
      />,
    );
  });
  return container;
}

function expectNoSocialChrome(el: HTMLElement) {
  expect(el.querySelector(".chat-hover-toolbar")).toBeNull();
  expect(el.querySelector(".chat-reaction-add")).toBeNull();
  expect(el.querySelector(".chat-hover-reply")).toBeNull();
  expect(el.querySelector(".chat-hover-ellipsis")).toBeNull();
  expect(el.querySelector(".chat-reaction-chip")).toBeNull();
  expect(el.querySelector(".chat-thread-affordance")).toBeNull();
}

describe("CL-6739: system / error / connect rows hide social chrome", () => {
  test("a join event row has no reaction, reply, or overflow", async () => {
    const el = await mount([
      {
        id: "join_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "event",
            event: "workbench.agent-joined",
            data: { address: "ins_scout@agents.example" },
          },
        ],
        sender: { name: null, address: "system@agents.example" },
      } as MessageItem,
    ]);

    expect(el.querySelector(".chat-event-line")).not.toBeNull();
    expectNoSocialChrome(el);
  });

  test("a generic system event row has no reaction, reply, or overflow", async () => {
    const el = await mount([
      {
        id: "sys_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "event",
            event: "workbench.membership-changed",
            data: {},
          },
        ],
        sender: { name: null, address: "system@agents.example" },
      } as MessageItem,
    ]);

    expect(el.querySelector(".chat-event-line")).not.toBeNull();
    expectNoSocialChrome(el);
  });

  test("a failed-turn error strip has no reaction, reply, or overflow", async () => {
    const el = await mount([
      {
        id: "fail_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "text",
            text: "I didn't get that one — send it again.",
            turnFailed: true,
          },
        ],
        sender: { name: null, address: "ins_echo@agents.example" },
      } as MessageItem,
    ]);

    expect(el.querySelector(".chat-turn-failed")).not.toBeNull();
    expectNoSocialChrome(el);
  });

  test("a connect-github card has no reaction, reply, or overflow", async () => {
    const el = await mount([
      {
        id: "connect_gh",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "block",
            block: {
              type: "connect-github",
              data: { requiredForTemplate: "github", state: "disconnected" },
            },
          },
        ],
        sender: { name: "Myra", address: "myra@agents.example" },
      } as MessageItem,
    ]);

    expectNoSocialChrome(el);
  });

  test("a connect-service card has no reaction, reply, or overflow", async () => {
    const el = await mount([
      {
        id: "connect_svc",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "block",
            block: {
              type: "connect-service",
              data: {
                connectorId: "gmail",
                displayName: "Gmail",
                reason: "Connect Gmail so I can send this for you.",
              },
            },
          },
        ],
        sender: { name: "Myra", address: "myra@agents.example" },
      } as MessageItem,
    ]);

    expectNoSocialChrome(el);
  });

  test("a classified inference failure keeps Fix this connection but drops social chrome", async () => {
    const el = await mount(
      [
        {
          id: "cred_fail",
          createdAt: "2026-01-01T00:00:00.000Z",
          parts: [
            {
              kind: "text",
              text: "This agent could not complete your request due to a credential error [HTTP 401]: invalid api key",
            },
          ],
          sender: { name: null, address: "prn_fixture1@agents.example" },
        } as MessageItem,
      ],
      { onFixConnection: () => undefined },
    );

    expect(el.querySelector(".chat-bubble-fix-connection")).not.toBeNull();
    expect(el.textContent).toContain("Fix this connection");
    expectNoSocialChrome(el);
  });

  test("an ordinary text message still gets the social hover toolbar", async () => {
    const el = await mount([
      {
        id: "m_ok",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "ship it" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      } as MessageItem,
    ]);

    const toolbar = el.querySelector(".chat-hover-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector(".chat-reaction-add")).not.toBeNull();
    expect(toolbar?.querySelector(".chat-hover-reply")).not.toBeNull();
    expect(toolbar?.querySelector(".chat-hover-ellipsis")).not.toBeNull();
  });

  test("right-click on a join row never opens the overflow menu", async () => {
    const el = await mount([
      {
        id: "join_2",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            kind: "event",
            event: "workbench.agent-joined",
            data: { address: "ins_scout@agents.example" },
          },
        ],
        sender: { name: null, address: "system@agents.example" },
      } as MessageItem,
    ]);

    const group = el.querySelector(".chat-message-group") as HTMLElement;
    await act(async () => {
      group.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });

    expect(document.querySelector('[data-slot="menu-content"]')).toBeNull();
  });
});
