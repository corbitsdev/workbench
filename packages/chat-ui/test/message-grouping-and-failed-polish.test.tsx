// DOM tests for the CL-6106 timeline polish pass: consecutive same-author
// messages collapse into a grouped run (avatar/name shown once, follow-ups
// indented with a hover-revealed timestamp), and a failed pending bubble's
// Retry/Discard render as proper react-ui buttons rather than underlined
// text links.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import type { PendingActions, TimelineMessageItem } from "../src/timeline";
import { ChannelTimeline } from "../src/timeline";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(items: readonly TimelineMessageItem[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ChannelTimeline items={items} />);
  });
  return container;
}

describe("consecutive same-author grouping", () => {
  test("a second message from the same author on the same day drops its avatar and header", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "first" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:00:30.000Z",
        parts: [{ kind: "text", text: "second" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[0]?.getAttribute("data-grouped")).toBe("false");
    expect(groups[1]?.getAttribute("data-grouped")).toBe("true");

    const rows = el.querySelectorAll(".chat-bubble-row");
    expect(rows[0]?.querySelector(".chat-sender-avatar-button")).not.toBeNull();
    expect(rows[0]?.querySelector(".chat-bubble-head")).not.toBeNull();

    expect(rows[1]?.getAttribute("data-grouped")).toBe("true");
    expect(rows[1]?.querySelector(".chat-sender-avatar-button")).toBeNull();
    expect(rows[1]?.querySelector(".chat-bubble-head")).toBeNull();
    expect(rows[1]?.querySelector(".chat-bubble-time-grouped")).not.toBeNull();
  });

  test("a different author never groups, even immediately after", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:00:05.000Z",
        parts: [{ kind: "text", text: "hello" }],
        sender: { name: "Ada", address: "ada@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[1]?.getAttribute("data-grouped")).toBe("false");
    expect(
      el
        .querySelectorAll(".chat-bubble-row")[1]
        ?.querySelector(".chat-bubble-head"),
    ).not.toBeNull();
  });

  test("a day divider always resets grouping, even for the same author", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T23:59:00.000Z",
        parts: [{ kind: "text", text: "before midnight" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-02T00:01:00.000Z",
        parts: [{ kind: "text", text: "after midnight" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[1]?.getAttribute("data-grouped")).toBe("false");
  });

  test("an event line between two messages from the same author breaks the group", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "first" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m2",
        createdAt: "2026-01-01T00:00:10.000Z",
        parts: [{ kind: "event", event: "channel.settings-changed", data: {} }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
      {
        id: "m3",
        createdAt: "2026-01-01T00:00:20.000Z",
        parts: [{ kind: "text", text: "third" }],
        sender: { name: "Researcher", address: "researcher@agents.example" },
      },
    ];
    const el = await mount(items);
    const groups = el.querySelectorAll(".chat-message-group");
    expect(groups[2]?.getAttribute("data-grouped")).toBe("false");
  });
});

describe("failed pending message's inline recovery affordance", () => {
  function failedItem(): TimelineMessageItem[] {
    return [
      {
        id: "pending_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_self1@agents.example" },
        pendingStatus: "failed",
        pendingNonce: "nonce_1",
      },
    ];
  }

  test("Retry and Discard render as real buttons, not underlined links", async () => {
    const pendingActions: PendingActions = {
      onRetry: () => {},
      onDiscard: () => {},
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ChannelTimeline
          items={failedItem()}
          currentUser={{ principalId: "prn_self1" }}
          pendingActions={pendingActions}
        />,
      );
    });

    const retry = container.querySelector(".chat-pending-retry");
    const discard = container.querySelector(".chat-pending-discard");
    expect(retry?.tagName).toBe("BUTTON");
    expect(discard?.tagName).toBe("BUTTON");
    expect(retry?.getAttribute("data-slot")).toBe("button");
    expect(discard?.getAttribute("data-slot")).toBe("button");
    expect(retry?.className).not.toContain("underline");
    expect(discard?.className).not.toContain("underline");

    expect(
      container.querySelector(".chat-pending-failed-label")?.textContent,
    ).toBe("Not sent");
  });
});
