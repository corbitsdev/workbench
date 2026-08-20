// DOM tests for CL-6332/CL-6376's failed-turn strip: the server's
// undelivered-turn notice (`postUndeliveredNotice`, `@corbits/chat`'s
// `workbench-service.ts`) marks its text part `turnFailed: true`; the
// general chat timeline renders that part as its own quiet inline system
// row (`.chat-turn-failed`, CL-6376) instead of an ordinary text bubble —
// or, before the CL-6376 redesign, `PrFailedTurnStrip`'s bordered banner.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { MessageItem } from "../src/api";
import { WorkbenchTimeline } from "../src/timeline";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function failedTurnItem(): MessageItem[] {
  return [
    {
      id: "msg_ok",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text", text: "hi @echo" }],
      sender: { name: null, address: "prn_alice@agents.example" },
    },
    {
      id: "msg_notice",
      createdAt: "2026-01-01T00:00:05.000Z",
      parts: [
        {
          kind: "text",
          text: "I didn't get that one — send it again and I'll pick it up.",
          turnFailed: true,
        },
      ],
      sender: { name: null, address: "ins_echo1@agents.example" },
    },
  ];
}

describe("the failed-turn notice renders through PrFailedTurnStrip", () => {
  test("shows the strip, not a plain text bubble, for the agent's own address", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
        />,
      );
    });

    const strip = container.querySelector(".chat-turn-failed");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("role")).toBe("status");
    expect(strip?.textContent).toContain("Echo");
    expect(strip?.textContent).toContain("didn't reply");

    // Never the old bordered-banner treatment.
    expect(container.querySelector(".chat-pr-failed")).toBeNull();

    // The notice never renders as an ordinary bubble alongside the strip.
    const bubbles = container.querySelectorAll(".chat-bubble");
    expect(
      [...bubbles].some((bubble) =>
        bubble.textContent?.includes("send it again"),
      ),
    ).toBe(false);
  });

  test("Retry and what-happened invoke the host's own actions with the failed item", async () => {
    const retried: string[] = [];
    const whatHappened: string[] = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          onRetryFailedTurn={(item) => retried.push(item.id)}
          onWhatHappenedFailedTurn={(item) => whatHappened.push(item.id)}
        />,
      );
    });

    const buttons = container.querySelectorAll(".chat-turn-failed button");
    expect(buttons).toHaveLength(2);
    act(() => {
      (buttons[0] as HTMLButtonElement).click();
    });
    act(() => {
      (buttons[1] as HTMLButtonElement).click();
    });

    expect(retried).toEqual(["msg_notice"]);
    expect(whatHappened).toEqual(["msg_notice"]);
  });

  test("an ordinary text part with no turnFailed flag still renders as a plain bubble", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={[
            {
              id: "msg_ok",
              createdAt: "2026-01-01T00:00:00.000Z",
              parts: [{ kind: "text", text: "hello" }],
              sender: { name: null, address: "prn_alice@agents.example" },
            },
          ]}
        />,
      );
    });

    expect(container.querySelector(".chat-turn-failed")).toBeNull();
    expect(container.querySelector(".chat-bubble")).not.toBeNull();
  });
});
