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
          onRetryFailedTurn={(item) => {
            retried.push(item.id);
          }}
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

  test("the expanded detail shows the notice's own cause-aware text, not a generic guess", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const items: MessageItem[] = [
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
            text: "I can't reach a model right now — add or check your model key in Settings, then I'll pick this up.",
            turnFailed: true,
          },
        ],
        sender: { name: null, address: "ins_echo1@agents.example" },
      },
    ];
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={items}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
        />,
      );
    });

    act(() => {
      container
        ?.querySelector(".chat-turn-failed-disclosure")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const detail = container.querySelector(".chat-turn-failed-detail");
    expect(detail?.textContent).toBe(
      "I can't reach a model right now — add or check your model key in Settings, then I'll pick this up.",
    );
    // Never the fixed guess this strip used to always show, regardless of cause.
    expect(detail?.textContent).not.toBe(
      "No reply arrived — the agent may be unavailable.",
    );
  });

  test("Retry auto-resends the recovered request text — no composer round trip", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const retried: (string | undefined)[] = [];
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          onRetryFailedTurn={(_item, retryText) => {
            retried.push(retryText);
          }}
        />,
      );
    });

    act(() => {
      (
        container?.querySelector(".chat-turn-failed-retry") as HTMLButtonElement
      ).click();
    });

    // The strip hands the recovered text straight to the host's resend
    // action — the host (chat-workspace.tsx) sends it through the normal
    // send path itself; the strip never touches a composer.
    expect(retried).toEqual(["hi @echo"]);
  });

  test("Retry disables itself while the resend is in flight, and re-enables once it settles", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const calls: (string | undefined)[] = [];
    let resolveSend: (() => void) | undefined;
    await act(async () => {
      root?.render(
        <WorkbenchTimeline
          items={failedTurnItem()}
          participants={[
            { address: "ins_echo1@agents.example", handle: "echo" },
          ]}
          onRetryFailedTurn={(_item, retryText) => {
            calls.push(retryText);
            return new Promise<void>((resolve) => {
              resolveSend = resolve;
            });
          }}
        />,
      );
    });

    const retryButton = () =>
      container?.querySelector(".chat-turn-failed-retry") as HTMLButtonElement;

    act(() => {
      retryButton().click();
    });
    // A second click while the first resend is still in flight must not
    // fire a second send.
    act(() => {
      retryButton().click();
    });

    expect(calls).toEqual(["hi @echo"]);
    expect(retryButton().disabled).toBe(true);

    await act(async () => {
      resolveSend?.();
      await Promise.resolve();
    });

    expect(retryButton().disabled).toBe(false);
  });
});
