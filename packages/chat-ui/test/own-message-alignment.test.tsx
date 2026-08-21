// The owner reversed CL-6488's flat, no-alignment timeline (itself matching
// the shell mock's "no right-alignment for you" spec, mock-spec.md §12.2):
// a shared workbench is multiplayer, so "your messages on the right" has to
// be evaluated per viewer, never baked into the message itself. The same
// server-issued item renders `data-own="true"` for the principal who sent
// it and `data-own="false"` for every other reader of that same bench —
// including a message an agent or teammate sent, which is never "own" for
// anyone but its author.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import type { CurrentUser } from "../src/timeline";
import { WorkbenchTimeline } from "../src/timeline";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(items: readonly MessageItem[], currentUser?: CurrentUser) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={items}
        {...(currentUser !== undefined ? { currentUser } : {})}
      />,
    );
  });
  return container;
}

function messageFrom(address: string): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "ship it" }],
      sender: { name: "Sawyer", address },
    },
  ];
}

describe("own-message alignment is per viewer, not per message", () => {
  test("a message authored by the viewing user renders right-aligned", async () => {
    const el = await mount(messageFrom("sawyer@agents.example"), {
      principalId: "sawyer",
    });
    const group = el.querySelector(".chat-message-group");
    const row = el.querySelector(".chat-bubble-row");
    const bubble = el.querySelector(".chat-bubble");
    expect(group?.getAttribute("data-own")).toBe("true");
    expect(row?.getAttribute("data-own")).toBe("true");
    expect(bubble?.getAttribute("data-own")).toBe("true");
  });

  test("the same message viewed by a different user renders left-aligned", async () => {
    const el = await mount(messageFrom("sawyer@agents.example"), {
      principalId: "pontus",
    });
    const group = el.querySelector(".chat-message-group");
    const row = el.querySelector(".chat-bubble-row");
    const bubble = el.querySelector(".chat-bubble");
    expect(group?.getAttribute("data-own")).toBe("false");
    expect(row?.getAttribute("data-own")).toBe("false");
    expect(bubble?.getAttribute("data-own")).toBe("false");
  });

  test("a system event line never gets own-message alignment, even when the current user caused it", async () => {
    const items: MessageItem[] = [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        sender: { name: "Sawyer", address: "sawyer@agents.example" },
        parts: [
          {
            kind: "event",
            event: "workbench.settings-changed",
            data: {
              changed: { "chat/name": "Launch plan" },
              previous: { "chat/name": "Untitled" },
            },
          },
        ],
      },
    ];
    const el = await mount(items, { principalId: "sawyer" });
    // The acting principal IS this reader, so the group itself reads as
    // "own" — but an event line has no bubble/avatar to align, and the
    // rendered `.chat-event-line` carries no own/alignment styling of its
    // own kind, so a system notice always reads the same regardless of
    // who triggered it.
    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("true");
    expect(el.querySelector(".chat-event-line")).not.toBeNull();
    expect(el.querySelector(".chat-bubble-row")).toBeNull();
  });

  test("no signed-in currentUser means nothing renders as own", async () => {
    const el = await mount(messageFrom("sawyer@agents.example"));
    expect(
      el.querySelector(".chat-message-group")?.getAttribute("data-own"),
    ).toBe("false");
  });
});
