// CL-6772: join / system notice rows sit on the left message edge — never
// the signed-in user's right edge — and keep the CL-6739 social-chrome gate.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import type { CurrentUser } from "../src/timeline";
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

async function mount(items: readonly MessageItem[], currentUser?: CurrentUser) {
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
        {...(currentUser !== undefined ? { currentUser } : {})}
      />,
    );
  });
  return container;
}

function joinItemFor(id: string, agentAddress: string): MessageItem {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    sender: { name: null, address: "sawyer@agents.example" },
    parts: [
      {
        kind: "event",
        event: "workbench.agent-joined",
        data: { address: agentAddress },
      },
    ],
  };
}

function textItem(id: string): MessageItem {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    sender: { name: "Sawyer", address: "sawyer@agents.example" },
    parts: [{ kind: "text", text: "Morning" }],
  };
}

function joinItem(senderAddress: string): MessageItem {
  return {
    id: "join_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    sender: { name: null, address: senderAddress },
    parts: [
      {
        kind: "event",
        event: "workbench.agent-joined",
        data: { address: "ins_scout@agents.example" },
      },
    ],
  };
}

describe("CL-6772: join / system notices stay on the left edge", () => {
  test("join row is never data-own, even when the viewer authored the post", async () => {
    const el = await mount([joinItem("sawyer@agents.example")], {
      principalId: "sawyer",
    });
    const group = el.querySelector(".chat-message-group");
    expect(group?.getAttribute("data-own")).toBe("false");
    expect(el.querySelector(".chat-event-line")).not.toBeNull();
    expect(el.querySelector(".chat-bubble-row")).toBeNull();
  });

  test("join row still hides reaction / reply / overflow chrome", async () => {
    const el = await mount([joinItem("sawyer@agents.example")], {
      principalId: "sawyer",
    });
    expect(el.querySelector(".chat-hover-toolbar")).toBeNull();
    expect(el.querySelector(".chat-reaction-add")).toBeNull();
    expect(el.querySelector(".chat-hover-reply")).toBeNull();
    expect(el.querySelector(".chat-hover-ellipsis")).toBeNull();
  });

  test("event-line CSS anchors left under the message gutter, not centered", () => {
    const cssPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../src/styles.css",
    );
    const css = readFileSync(cssPath, "utf8");
    const block = css.match(/\.chat-event-line\s*\{[^}]+\}/);
    expect(block).not.toBeNull();
    expect(block?.[0]).toContain("justify-content: flex-start");
    expect(block?.[0]).not.toContain("justify-content: center");
    // Same left gutter the failed-turn strip and gen-ui blocks use, so the
    // notice sits under the message column rather than the row's midpoint.
    expect(block?.[0]).toMatch(/2\.9rem/);
  });
});

describe("a whole team arriving reads as one line, not a join dump", () => {
  test("three consecutive joins collapse into one line naming everyone", async () => {
    const el = await mount([
      joinItemFor("j1", "correctness-reviewer@agents.example"),
      joinItemFor("j2", "architecture-reviewer@agents.example"),
      joinItemFor("j3", "release-risk-reviewer@agents.example"),
    ]);
    const lines = [...el.querySelectorAll(".chat-event-line")];
    expect(lines).toHaveLength(1);
    const text = lines[0]?.textContent ?? "";
    expect(text).toContain("Correctness Reviewer");
    expect(text).toContain("Architecture Reviewer");
    expect(text).toContain("Release Risk Reviewer");
    expect(text.match(/joined/g)).toHaveLength(1);
  });

  test("joins separated by a real message stay their own rows", async () => {
    const el = await mount([
      joinItemFor("j1", "correctness-reviewer@agents.example"),
      textItem("t1"),
      joinItemFor("j2", "architecture-reviewer@agents.example"),
    ]);
    const lines = [...el.querySelectorAll(".chat-event-line")];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain("Correctness Reviewer joined");
    expect(lines[1]?.textContent).toContain("Architecture Reviewer joined");
  });
});
