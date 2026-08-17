// DOM tests for the poll card's live round-trip. `BlockResponseActions` is
// the mock boundary, the same way `ApprovalActions` is for the approve
// card: a fake stands in for the host's fetch-backed read/vote calls.
// Covers: vote casts and renders a server-read tally, a second vote changes
// it (upsert = change vote), and the render never trusts anything but the
// last `getResponses` read — not the click that triggered it, and never
// anything the poll block's own agent-authored data carries (it has no
// tally field at all; see `packages/chat/src/blocks.ts`).

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  BlockResponseActions,
  BlockResponseQuery,
  BlockResponseSubmitResult,
} from "../src/blocks/block-responses";
import type { MessageItem } from "../src/api";
import { ChannelTimeline } from "../src/timeline";

function messageWithPollBlock(): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "block",
          block: {
            type: "poll",
            data: {
              pollId: "blk_poll1",
              title: "Ship day?",
              choices: [
                { id: "tue", label: "Tuesday" },
                { id: "thu", label: "Thursday" },
              ],
            },
          },
        },
      ],
      sender: { name: "Researcher", address: "researcher@agents.example" },
    },
  ];
}

/** A stateful fake: casting a vote actually changes what the next
 * `getResponses` read returns, the same way the real server's upsert +
 * re-read behaves — so tests exercise the real "always re-sync" contract
 * rather than trusting a submit call's own return value. */
function fakeBackend() {
  const votesByPrincipal = new Map<string, readonly string[]>();
  const submitCalls: { choiceIds: readonly string[] }[] = [];

  const actions: BlockResponseActions = {
    getResponses: async (): Promise<BlockResponseQuery> => {
      const tally: Record<string, number> = {};
      let total = 0;
      for (const choiceIds of votesByPrincipal.values()) {
        total += 1;
        for (const id of choiceIds) tally[id] = (tally[id] ?? 0) + 1;
      }
      const own = votesByPrincipal.get("me");
      return {
        kind: "ready",
        tally,
        total,
        own: own === undefined ? null : { kind: "poll", choiceIds: own },
      };
    },
    submitPoll: async (
      _messageId,
      _blockId,
      choiceIds,
    ): Promise<BlockResponseSubmitResult> => {
      submitCalls.push({ choiceIds });
      votesByPrincipal.set("me", choiceIds);
      return { kind: "submitted" };
    },
    submitForm: async () => ({ kind: "submitted" }),
    submitQuestion: async () => ({ kind: "submitted" }),
  };

  return { actions, submitCalls, votesByPrincipal };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(actions: BlockResponseActions) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ChannelTimeline
        items={messageWithPollBlock()}
        blockResponses={actions}
      />,
    );
  });
  return container;
}

describe("poll card round-trip", () => {
  test("with no port, choices render disabled with no tally — the pre-round-trip fallback", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ChannelTimeline items={messageWithPollBlock()} />);
    });

    const buttons = container.querySelectorAll(".chat-block-choice");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(container.textContent).not.toContain("vote");
  });

  test("casting a vote calls the port and renders the server's tally, not a client guess", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);

    const tuesday = [...el.querySelectorAll(".chat-block-poll-choice")].find(
      (button) => button.textContent?.includes("Tuesday"),
    ) as HTMLButtonElement;

    await act(async () => {
      tuesday.click();
    });

    expect(backend.submitCalls).toEqual([{ choiceIds: ["tue"] }]);
    expect(el.textContent).toContain("1 vote");
    expect(tuesday.dataset["selected"]).toBe("true");
    expect(el.textContent).toContain("Your vote");
  });

  test("a second vote changes the choice — upsert, not a second row", async () => {
    const backend = fakeBackend();
    const el = await mount(backend.actions);

    const choices = [...el.querySelectorAll(".chat-block-poll-choice")];
    const tuesday = choices.find((b) => b.textContent?.includes("Tuesday")) as
      HTMLButtonElement | undefined;
    const thursday = choices.find((b) =>
      b.textContent?.includes("Thursday"),
    ) as HTMLButtonElement | undefined;
    if (tuesday === undefined || thursday === undefined) {
      throw new Error("expected both choices to render");
    }

    await act(async () => {
      tuesday.click();
    });
    await act(async () => {
      thursday.click();
    });

    expect(backend.votesByPrincipal.get("me")).toEqual(["thu"]);
    // Total respondents stays 1 — the same principal changed their vote,
    // never counted twice.
    expect(el.textContent).toContain("1 vote");
    const refreshedThursday = [
      ...el.querySelectorAll(".chat-block-poll-choice"),
    ].find((b) => b.textContent?.includes("Thursday")) as HTMLButtonElement;
    expect(refreshedThursday.dataset["selected"]).toBe("true");
  });

  test("the rendered tally always comes from the last read, never trusted ahead of it", async () => {
    // A backend whose read disagrees with what a naive optimistic guess
    // would show (2 votes already on file for "thu" before this principal
    // ever acts) — the render must reflect the real read, not a local
    // increment scheme.
    const actions: BlockResponseActions = {
      getResponses: async () => ({
        kind: "ready",
        tally: { thu: 2 },
        total: 2,
        own: null,
      }),
      submitPoll: async () => ({ kind: "submitted" }),
      submitForm: async () => ({ kind: "submitted" }),
      submitQuestion: async () => ({ kind: "submitted" }),
    };
    const el = await mount(actions);

    expect(el.textContent).toContain("2 votes");
  });
});
