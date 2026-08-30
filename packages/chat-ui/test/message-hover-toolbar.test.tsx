// Hover toolbar: add-reaction / reply-in-thread / Edit (own prompts) /
// ellipsis. The ellipsis button and a right-click on the message open the
// same menu — see `buildMessageMenu` in `timeline.tsx`.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WorkbenchTimeline } from "../src/timeline";
import type {
  CurrentUser,
  PinActions,
  ReactionActions,
  TimelineMessageItem,
} from "../src/timeline";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chatUiCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
  "utf8",
);

function cssRuleBodies(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...chatUiCss.matchAll(
      new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`, "g"),
    ),
  ].map((match) => match[1] ?? "");
}

/** Radix's exit-animation handling runs through a couple of microtasks even
 * with no real CSS animation configured — see the identical helper in
 * `@corbits/context-menu`'s own `context-menu-view.test.tsx`. */
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(0);
    await sleep(0);
  });
}

function textMessage(
  overrides: Partial<TimelineMessageItem> = {},
): TimelineMessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "ship it" }],
      sender: { name: "Researcher", address: "researcher@agents.example" },
      ...overrides,
    },
  ];
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(props: {
  items: TimelineMessageItem[];
  onOpenThread?: (messageId: string) => void;
  onEditMessage?: (messageId: string) => void;
  currentUser?: CurrentUser;
  reactionActions?: ReactionActions;
  pinActions?: PinActions;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={props.items}
        {...(props.onOpenThread !== undefined
          ? { onOpenThread: props.onOpenThread }
          : {})}
        {...(props.onEditMessage !== undefined
          ? { onEditMessage: props.onEditMessage }
          : {})}
        {...(props.currentUser !== undefined
          ? { currentUser: props.currentUser }
          : {})}
        {...(props.reactionActions !== undefined
          ? { reactionActions: props.reactionActions }
          : {})}
        {...(props.pinActions !== undefined
          ? { pinActions: props.pinActions }
          : {})}
      />,
    );
  });
  return container;
}

describe("message hover toolbar", () => {
  test("with no host actions wired, only the ellipsis (copy text) shows — no reply, no add-reaction", async () => {
    const el = await mount({ items: textMessage() });
    const toolbar = el.querySelector(".chat-hover-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector(".chat-hover-reply")).toBeNull();
    expect(toolbar?.querySelector(".chat-reaction-add")).toBeNull();
    expect(toolbar?.querySelector(".chat-hover-ellipsis")).not.toBeNull();
  });

  test("carries add-reaction, reply, and ellipsis once any action is wired", async () => {
    const el = await mount({
      items: textMessage(),
      onOpenThread: () => undefined,
      reactionActions: { onToggle: () => undefined },
    });

    const toolbar = el.querySelector(".chat-hover-toolbar");
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector(".chat-reaction-add")).not.toBeNull();
    expect(toolbar?.querySelector(".chat-hover-reply")).not.toBeNull();
    expect(toolbar?.querySelector(".chat-hover-ellipsis")).not.toBeNull();
  });

  test("the hover reply button calls onOpenThread directly", async () => {
    const opened: string[] = [];
    const el = await mount({
      items: textMessage(),
      onOpenThread: (id) => opened.push(id),
    });

    const reply = el.querySelector(".chat-hover-reply") as HTMLButtonElement;
    await act(async () => reply.click());

    expect(opened).toEqual(["m1"]);
  });
});

describe("hover Edit on own prompts", () => {
  test("Edit appears only when the row is the signed-in user's own prompt", async () => {
    const el = await mount({
      items: textMessage(),
      currentUser: { principalId: "researcher" },
      onEditMessage: () => undefined,
    });

    const group = el.querySelector(".chat-message-group");
    expect(group?.getAttribute("data-own")).toBe("true");
    const edit = el.querySelector(".chat-hover-edit");
    expect(edit).not.toBeNull();
    expect(edit?.tagName).toBe("BUTTON");
    expect(edit?.getAttribute("aria-label")).toBe("Edit");
  });

  test("Edit is absent on someone else's prompt even when onEditMessage is wired", async () => {
    const el = await mount({
      items: textMessage(),
      currentUser: { principalId: "someone-else" },
      onEditMessage: () => undefined,
    });

    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("false");
    expect(el.querySelector(".chat-hover-edit")).toBeNull();
  });

  test("Edit is absent on a pending own send", async () => {
    const el = await mount({
      items: textMessage({ pendingStatus: "sending" }),
      currentUser: { principalId: "researcher" },
      onEditMessage: () => undefined,
    });

    expect(el.querySelector(".chat-hover-toolbar")).toBeNull();
    expect(el.querySelector(".chat-hover-edit")).toBeNull();
  });

  test("Edit is absent on a streaming row", async () => {
    const el = await mount({
      items: textMessage({ streaming: true }),
      currentUser: { principalId: "researcher" },
      onEditMessage: () => undefined,
    });

    expect(el.querySelector(".chat-hover-toolbar")).toBeNull();
    expect(el.querySelector(".chat-hover-edit")).toBeNull();
  });

  test("Edit is absent on a file-only own row", async () => {
    const el = await mount({
      items: textMessage({
        parts: [
          {
            kind: "file",
            name: "report.pdf",
            mediaType: "application/pdf",
            data: "JVBERi0xLjQK",
          },
        ],
      }),
      currentUser: { principalId: "researcher" },
      onEditMessage: () => undefined,
    });

    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("true");
    expect(el.querySelector(".chat-hover-edit")).toBeNull();
  });

  test("clicking Edit calls onEditMessage with the message id and does not open a thread", async () => {
    const edited: string[] = [];
    const opened: string[] = [];
    const el = await mount({
      items: textMessage(),
      currentUser: { principalId: "researcher" },
      onEditMessage: (id) => edited.push(id),
      onOpenThread: (id) => opened.push(id),
    });

    const edit = el.querySelector(".chat-hover-edit") as HTMLButtonElement;
    await act(async () => edit.click());

    expect(edited).toEqual(["m1"]);
    expect(opened).toEqual([]);
  });

  test("the hover reply button still only opens a thread", async () => {
    const edited: string[] = [];
    const opened: string[] = [];
    const el = await mount({
      items: textMessage(),
      currentUser: { principalId: "researcher" },
      onEditMessage: (id) => edited.push(id),
      onOpenThread: (id) => opened.push(id),
    });

    const reply = el.querySelector(".chat-hover-reply") as HTMLButtonElement;
    await act(async () => reply.click());

    expect(opened).toEqual(["m1"]);
    expect(edited).toEqual([]);
  });
});

describe("own-prompt hover toolbar is mirrored off the prompt", () => {
  test("own rows pin the toolbar to the inboard (left) edge", () => {
    const bodies = cssRuleBodies(
      '.chat-message-group[data-own="true"] .chat-hover-toolbar',
    );
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[0] ?? "";
    expect(body).toMatch(/right:\s*auto/);
    expect(body).toMatch(/left:\s*0\.4rem/);
  });

  test("other rows keep the default trailing (right) edge", () => {
    const bodies = cssRuleBodies(".chat-hover-toolbar");
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[0] ?? "";
    expect(body).toMatch(/right:\s*0\.4rem/);
    expect(body).not.toMatch(/left:/);
  });

  test("hover, focus-within, and data-open still reveal the toolbar", () => {
    expect(chatUiCss).toMatch(
      /\.chat-message-group:hover\s+\.chat-hover-toolbar/,
    );
    expect(chatUiCss).toMatch(
      /\.chat-message-group:focus-within\s+\.chat-hover-toolbar/,
    );
    expect(chatUiCss).toMatch(/\.chat-hover-toolbar\[data-open="true"\]/);
  });
});

describe("the persistent inline 'Reply in thread' link is gone", () => {
  test("a message with no replies yet renders no .chat-thread-affordance row", async () => {
    const el = await mount({
      items: textMessage(),
      onOpenThread: () => undefined,
    });

    expect(el.querySelector(".chat-thread-affordance")).toBeNull();
    // The action still exists — just hover-gated, not a persistent row.
    expect(el.querySelector(".chat-hover-reply")).not.toBeNull();
  });

  test("a message that already has replies still shows its thread summary row", async () => {
    const el = await mount({ items: textMessage() });
    // threadMetaByMessageId isn't wired in this mount, but WorkbenchTimeline
    // only renders the summary row at all when onOpenThread is passed —
    // remount with both to exercise the replyCount > 0 branch.
    const withReplies = document.createElement("div");
    document.body.appendChild(withReplies);
    const repliesRoot = createRoot(withReplies);
    await act(async () => {
      repliesRoot.render(
        <WorkbenchTimeline
          items={textMessage()}
          onOpenThread={() => undefined}
          threadMetaByMessageId={
            new Map([
              [
                "m1",
                {
                  replyCount: 3,
                  lastActivityAt: null,
                  participantAddresses: [],
                },
              ],
            ])
          }
        />,
      );
    });

    expect(withReplies.querySelector(".chat-thread-affordance")).not.toBeNull();
    expect(
      withReplies.querySelector(".chat-thread-reply-count")?.textContent,
    ).toBe("3 replies");

    act(() => repliesRoot.unmount());
    withReplies.remove();
    el.remove();
  });
});

describe("reactions still render as chips regardless of the hover toolbar", () => {
  test("an existing reaction is always visible, not just on hover", async () => {
    const el = await mount({
      items: textMessage({
        reactions: [{ emoji: "👍", count: 2, reactedByMe: false }],
      }),
      reactionActions: { onToggle: () => undefined },
    });

    expect(el.querySelector(".chat-reaction-chip")).not.toBeNull();
    expect(el.querySelector(".chat-reaction-chip")?.textContent).toContain("2");
  });
});

describe("the reaction picker", () => {
  test("a pointerdown outside the open picker closes it", async () => {
    const el = await mount({
      items: textMessage(),
      reactionActions: { onToggle: () => undefined },
    });

    const trigger = el.querySelector(".chat-reaction-add") as HTMLButtonElement;
    await act(async () => trigger.click());
    expect(el.querySelector(".chat-reaction-picker")).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });

    expect(el.querySelector(".chat-reaction-picker")).toBeNull();
  });

  test("a pointerdown on the picker itself never closes it", async () => {
    const el = await mount({
      items: textMessage(),
      reactionActions: { onToggle: () => undefined },
    });

    const trigger = el.querySelector(".chat-reaction-add") as HTMLButtonElement;
    await act(async () => trigger.click());

    const option = el.querySelector(
      ".chat-reaction-picker-option",
    ) as HTMLButtonElement;
    await act(async () => {
      option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });

    expect(el.querySelector(".chat-reaction-picker")).not.toBeNull();
  });
});

describe("the ellipsis menu", () => {
  test("opens with Reply in thread and Copy text, and clicking Reply in thread calls onOpenThread", async () => {
    const opened: string[] = [];
    const el = await mount({
      items: textMessage(),
      onOpenThread: (id) => opened.push(id),
    });

    const ellipsis = el.querySelector(
      ".chat-hover-ellipsis",
    ) as HTMLButtonElement;
    await act(async () => ellipsis.click());
    await flush();

    const items = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]'),
    );
    const labels = items.map((item) => item.textContent);
    expect(labels).toContain("Reply in thread");
    expect(labels).toContain("Copy text");

    const replyItem = items.find(
      (item) => item.textContent === "Reply in thread",
    );
    act(() => replyItem?.click());
    await flush();

    expect(opened).toEqual(["m1"]);
  });

  test("includes Pin message when pinActions is wired", async () => {
    const el = await mount({
      items: textMessage(),
      pinActions: { onPin: () => undefined, onUnpin: () => undefined },
    });

    const ellipsis = el.querySelector(
      ".chat-hover-ellipsis",
    ) as HTMLButtonElement;
    await act(async () => ellipsis.click());
    await flush();

    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]'),
    ).map((item) => item.textContent);
    expect(labels).toContain("Pin message");
  });

  test("right-clicking the message opens the same menu", async () => {
    const el = await mount({
      items: textMessage(),
      onOpenThread: () => undefined,
    });

    expect(document.querySelector('[data-slot="menu-content"]')).toBeNull();

    const group = el.querySelector(".chat-message-group") as HTMLElement;
    await act(async () => {
      group.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
    await flush();

    expect(document.querySelector('[data-slot="menu-content"]')).not.toBeNull();
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]'),
    ).map((item) => item.textContent);
    expect(labels).toContain("Reply in thread");
    expect(labels).toContain("Copy text");
  });
});
