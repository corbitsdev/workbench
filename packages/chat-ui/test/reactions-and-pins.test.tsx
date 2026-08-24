// DOM tests for the reaction chip row and pin toggle the timeline
// renders per message, plus the pinned strip. `ReactionActions`/
// `PinActions` are the mock boundary, the same way `BlockResponseActions`
// is for the poll card: a fake stands in for the host's fetch-backed
// toggle/pin calls, and the assertions are on what the click actually
// invoked — never on the click alone.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { MessageItem, PinnedMessage } from "../src/api";
import { PinnedStrip } from "../src/pinned-strip";
import { WorkbenchTimeline, messageDomId } from "../src/timeline";
import type { PinActions, ReactionActions } from "../src/timeline";

function messageWithReactions(): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "ship it" }],
      sender: { name: "Researcher", address: "researcher@agents.example" },
      reactions: [{ emoji: "👍", count: 2, reactedByMe: false }],
      pinned: false,
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

async function mount(
  items: MessageItem[],
  reactionActions?: ReactionActions,
  pinActions?: PinActions,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={items}
        {...(reactionActions !== undefined ? { reactionActions } : {})}
        {...(pinActions !== undefined ? { pinActions } : {})}
      />,
    );
  });
  return container;
}

describe("reaction chip row", () => {
  test("with no reactionActions, no chip and no add-reaction trigger render at all", async () => {
    const el = await mount(messageWithReactions());
    expect(el.querySelector(".chat-reaction-chip")).toBeNull();
    expect(el.querySelector(".chat-reaction-add")).toBeNull();
  });

  test("an existing reaction renders as a chip with its count", async () => {
    const calls: { messageId: string; emoji: string }[] = [];
    const el = await mount(messageWithReactions(), {
      onToggle: (messageId, emoji) => calls.push({ messageId, emoji }),
    });

    const chip = el.querySelector(".chat-reaction-chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("2");
    expect(chip.dataset["reacted"]).toBe("false");
  });

  test("clicking an existing chip toggles it — the host's onToggle, not local state", async () => {
    const calls: { messageId: string; emoji: string }[] = [];
    const el = await mount(messageWithReactions(), {
      onToggle: (messageId, emoji) => calls.push({ messageId, emoji }),
    });

    const chip = el.querySelector(".chat-reaction-chip") as HTMLButtonElement;
    await act(async () => chip.click());

    expect(calls).toEqual([{ messageId: "m1", emoji: "👍" }]);
  });

  test("the add-reaction trigger opens a curated picker, and picking an emoji toggles it", async () => {
    const calls: { messageId: string; emoji: string }[] = [];
    const el = await mount(messageWithReactions(), {
      onToggle: (messageId, emoji) => calls.push({ messageId, emoji }),
    });

    const trigger = el.querySelector(".chat-reaction-add") as HTMLButtonElement;
    expect(el.querySelector(".chat-reaction-picker")).toBeNull();

    await act(async () => trigger.click());
    const picker = el.querySelector(".chat-reaction-picker");
    expect(picker).not.toBeNull();

    const options = el.querySelectorAll(".chat-reaction-picker-option");
    expect(options.length).toBeGreaterThan(1);

    await act(async () => (options[1] as HTMLButtonElement).click());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messageId).toBe("m1");
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Radix's exit-animation handling runs through a couple of microtasks even
 * with no real CSS animation configured — mirrors the identical helper in
 * `test/message-hover-toolbar.test.tsx`. */
async function flush(): Promise<void> {
  await act(async () => {
    await sleep(0);
    await sleep(0);
  });
}

describe("pin toggle", () => {
  // CL-6376: an unpinned message renders no persistent glyph at all — the
  // pin toggle only mounts once a message is actually pinned (needing a
  // visible way to unpin it). Pinning itself stays reachable through the
  // ellipsis/context menu's own "Pin message" entry either way.
  test("with no pinActions, no pin button renders", async () => {
    const el = await mount(messageWithReactions());
    expect(el.querySelector(".chat-pin-toggle")).toBeNull();
  });

  test("an unpinned message renders no pin toggle, even with pinActions wired", async () => {
    const el = await mount(messageWithReactions(), undefined, {
      onPin: () => undefined,
      onUnpin: () => undefined,
    });
    expect(el.querySelector(".chat-pin-toggle")).toBeNull();
  });

  test("an unpinned message can still be pinned through the context menu's onPin", async () => {
    const pinned: string[] = [];
    const el = await mount(messageWithReactions(), undefined, {
      onPin: (id) => pinned.push(id),
      onUnpin: () => undefined,
    });

    const group = el.querySelector(".chat-message-group") as HTMLElement;
    await act(async () => {
      group.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
    await flush();

    const pinItem = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]'),
    ).find((item) => item.textContent === "Pin message");
    expect(pinItem).not.toBeUndefined();
    await act(async () => pinItem?.click());

    expect(pinned).toEqual(["m1"]);
  });

  test("a pinned message's pin button calls onUnpin", async () => {
    const pinned: string[] = [];
    const unpinned: string[] = [];
    const items: MessageItem[] = [
      { ...messageWithReactions()[0], pinned: true } as MessageItem,
    ];
    const el = await mount(items, undefined, {
      onPin: (id) => pinned.push(id),
      onUnpin: (id) => unpinned.push(id),
    });

    const button = el.querySelector(".chat-pin-toggle") as HTMLButtonElement;
    expect(button.dataset["pinned"]).toBe("true");
    await act(async () => button.click());

    expect(unpinned).toEqual(["m1"]);
    expect(pinned).toEqual([]);
  });
});

describe("pinned strip", () => {
  const pins: PinnedMessage[] = [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "important announcement here" }],
      sender: { name: "Researcher", address: "researcher@agents.example" },
      pinnedBy: "prn_alice",
      pinnedAt: "2026-01-01T00:01:00.000Z",
    },
  ];

  test("renders nothing with no pinned messages", () => {
    const markup = renderToStaticMarkup(
      <PinnedStrip
        status={{ kind: "ready", items: [] }}
        onJump={() => undefined}
      />,
    );
    expect(markup).toBe("");
  });

  test("renders nothing while loading or when pins are unavailable on this host", () => {
    expect(
      renderToStaticMarkup(
        <PinnedStrip status={{ kind: "loading" }} onJump={() => undefined} />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <PinnedStrip
          status={{ kind: "unavailable" }}
          onJump={() => undefined}
        />,
      ),
    ).toBe("");
  });

  test("a load failure renders an error strip — never the honest-empty silence (CL-6832)", () => {
    const markup = renderToStaticMarkup(
      <PinnedStrip
        status={{
          kind: "error",
          message: "Couldn't load pinned messages.",
        }}
        onJump={() => undefined}
      />,
    );
    // Static markup escapes the apostrophe; the alert role is the
    // empty-vs-error distinction the strip must keep.
    expect(markup).toContain("Couldn&#x27;t load pinned messages.");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("chat-pinned-strip-error");
    expect(markup).not.toContain("chat-pinned-strip-item");
  });

  test("renders a jump chip previewing the pinned message's text", () => {
    const markup = renderToStaticMarkup(
      <PinnedStrip
        status={{ kind: "ready", items: pins }}
        onJump={() => undefined}
      />,
    );
    expect(markup).toContain("important announcement here");
  });

  test("clicking a pin chip calls onJump with the message id", async () => {
    const jumped: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <PinnedStrip
          status={{ kind: "ready", items: pins }}
          onJump={(id) => jumped.push(id)}
        />,
      );
    });

    const chip = container.querySelector(
      ".chat-pinned-strip-item",
    ) as HTMLButtonElement;
    await act(async () => chip.click());

    expect(jumped).toEqual(["m1"]);
  });

  test("messageDomId is the timeline's own message group id — the strip's jump target actually exists", async () => {
    const el = await mount(messageWithReactions());
    expect(el.querySelector(`#${messageDomId("m1")}`)).not.toBeNull();
  });
});
