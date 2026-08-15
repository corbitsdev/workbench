// DOM tests for the approve card's live round-trip. The host port
// (`ApprovalActions`) is the mock boundary — a fake implementation stands in
// for the host's fetch-backed reads/writes, the same way the block never
// talks to `fetch` itself. Covers: pending+actable, pending+spectator,
// approve success (through to the invalidation callback the host's real
// port would run), approve failure (no fake resolution), an
// already-resolved render, the platform-truth panel (never agent framing
// alone next to live buttons), and the read-then-act conflict race.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  ApprovalActions,
  ApprovalDecisionResult,
  ApprovalLiveStatus,
  ApprovalStatusQuery,
  PlatformApprovalDetail,
} from "../src/blocks/approval-actions";
import type { MessageItem } from "../src/api";
import { ChannelTimeline } from "../src/timeline";

const PLATFORM_DETAIL: PlatformApprovalDetail = {
  agentName: "Payments Bot",
  headline: "Wire $50,000 to acct_9182",
  arguments: { destination: "acct_9182", amountUsd: "50000" },
};

function messageWithApproveBlock(approvalId: string): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "block",
          block: {
            type: "approve",
            data: {
              approvalId,
              title: "Refresh cache",
              risk: "low",
              body: "Just a routine refresh, nothing to worry about!",
            },
          },
        },
      ],
      sender: { name: "Researcher", address: "researcher@agents.example" },
    },
  ];
}

function fakeActions(overrides: Partial<ApprovalActions>): ApprovalActions {
  return {
    getStatus: async () => ({ kind: "loading" }) as ApprovalStatusQuery,
    approve: async () =>
      ({ kind: "resolved", status: "approved" }) as ApprovalDecisionResult,
    reject: async () =>
      ({ kind: "resolved", status: "rejected" }) as ApprovalDecisionResult,
    ...overrides,
  };
}

/** A stateful fake standing in for the host's read/write round-trip: a
 * decision actually changes what the next `getStatus` returns, the same
 * way the real platform's approve/reject + re-read behaves. Lets tests
 * exercise "the card re-syncs after any decision outcome" honestly instead
 * of asserting against a decision response the card is no longer supposed
 * to trust on its own. */
function fakeBackend(
  initialStatus: ApprovalLiveStatus,
  canAct: boolean,
  detail: PlatformApprovalDetail = PLATFORM_DETAIL,
) {
  let status = initialStatus;
  const approveCalls: string[] = [];

  const actions: ApprovalActions = {
    getStatus: async () => ({ kind: "ready", status, canAct, detail }),
    approve: async (id) => {
      approveCalls.push(id);
      status = "approved";
      return { kind: "resolved", status: "approved" };
    },
    reject: async () => {
      status = "rejected";
      return { kind: "resolved", status: "rejected" };
    },
  };

  return { actions, approveCalls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mount(actions: ApprovalActions, approvalId = "apv_1") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ChannelTimeline
        items={messageWithApproveBlock(approvalId)}
        approvalActions={actions}
      />,
    );
  });
  return container;
}

describe("approve card round-trip", () => {
  test("pending + actable: buttons render enabled and call the port", async () => {
    const backend = fakeBackend("pending", true);
    const el = await mount(backend.actions);

    const buttons = el.querySelectorAll(".chat-block-actions button");
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });

    expect(backend.approveCalls).toEqual(["apv_1"]);
    expect(el.textContent).toContain("Approved");
  });

  test("pending + spectator: status and platform detail shown, no buttons", async () => {
    const el = await mount(fakeBackend("pending", false).actions);

    expect(el.querySelectorAll(".chat-block-actions button")).toHaveLength(0);
    expect(el.textContent).toContain(
      "Only an approver on this workbench can act on this.",
    );
    expect(el.textContent).toContain("Wire $50,000 to acct_9182");
  });

  test("the platform's own headline and arguments render, always ahead of the agent's framing", async () => {
    const el = await mount(fakeBackend("pending", true).actions);

    expect(el.textContent).toContain("Payments Bot");
    expect(el.textContent).toContain("Wire $50,000 to acct_9182");
    expect(el.textContent).toContain("acct_9182");
    expect(el.textContent).toContain("50000");

    // Both the platform truth and the agent's own (demoted) framing are on
    // the page, but the platform detail must appear first in document
    // order — never the agent's framing standing in ahead of it.
    const platformIndex = el.innerHTML.indexOf("Wire $50,000 to acct_9182");
    const agentIndex = el.innerHTML.indexOf(
      "Just a routine refresh, nothing to worry about!",
    );
    expect(platformIndex).toBeGreaterThan(-1);
    expect(agentIndex).toBeGreaterThan(-1);
    expect(platformIndex).toBeLessThan(agentIndex);
  });

  test("a forbidden status read renders live buttons with NO description at all — never the agent's framing standing in for the platform's", async () => {
    const el = await mount(
      fakeActions({
        getStatus: async () => ({ kind: "forbidden" }),
        approve: async () => ({ kind: "forbidden", message: "nope" }),
      }),
    );

    const buttons = el.querySelectorAll(".chat-block-actions button");
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);

    // The agent's own body text — the exact confused-deputy risk (an
    // innocuous "Refresh cache" framing over a real wire transfer) — must
    // never render as the description sitting next to live buttons.
    expect(el.textContent).not.toContain(
      "Just a routine refresh, nothing to worry about!",
    );

    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });
    expect(el.textContent).toContain(
      "You do not have permission to act on this.",
    );
  });

  test("approve success re-renders resolved state from a re-read and invalidates", async () => {
    let invalidated = false;
    const backend = fakeBackend("pending", true);
    const originalApprove = backend.actions.approve;
    const actions: ApprovalActions = {
      ...backend.actions,
      approve: async (id) => {
        invalidated = true; // stands in for the host's queryClient.invalidateQueries
        return originalApprove(id);
      },
    };
    const el = await mount(actions);

    const approveButton = el.querySelector(
      ".chat-block-actions button",
    ) as HTMLButtonElement;
    await act(async () => {
      approveButton.click();
    });

    expect(invalidated).toBe(true);
    expect(el.querySelectorAll(".chat-block-actions button")).toHaveLength(0);
    expect(el.textContent).toContain("Approved");
  });

  test("approve failure re-syncs from a read and never fakes resolution", async () => {
    const el = await mount(
      fakeActions({
        getStatus: async () => ({
          kind: "ready",
          status: "pending",
          canAct: true,
          detail: PLATFORM_DETAIL,
        }),
        approve: async () => ({ kind: "error", message: "network down" }),
      }),
    );

    const approveButton = el.querySelector(
      ".chat-block-actions button",
    ) as HTMLButtonElement;
    await act(async () => {
      approveButton.click();
    });

    expect(el.textContent).toContain("Couldn't reach the approval");
    expect(el.textContent).not.toContain("Approved");
    // Buttons remain — the re-read still says pending, not silently resolved.
    expect(el.querySelectorAll(".chat-block-actions button")).toHaveLength(2);
  });

  test("read-then-act race: a conflict re-fetches and renders the resolved state, buttons gone", async () => {
    let reads = 0;
    const actions: ApprovalActions = {
      getStatus: async () => {
        reads += 1;
        // First read (initial mount): still pending, actionable. Second
        // read (after the conflicting decision): someone else got there
        // first and it's now approved.
        return reads === 1
          ? {
              kind: "ready",
              status: "pending",
              canAct: true,
              detail: PLATFORM_DETAIL,
            }
          : {
              kind: "ready",
              status: "approved",
              canAct: false,
              detail: PLATFORM_DETAIL,
            };
      },
      approve: async () => ({ kind: "conflict", message: "already resolved" }),
      reject: async () => ({ kind: "resolved", status: "rejected" }),
    };
    const el = await mount(actions);

    const approveButton = el.querySelector(
      ".chat-block-actions button",
    ) as HTMLButtonElement;
    await act(async () => {
      approveButton.click();
    });

    expect(reads).toBe(2);
    expect(el.querySelectorAll(".chat-block-actions button")).toHaveLength(0);
    expect(el.textContent).toContain("Approved");
    expect(el.textContent).toContain(
      "Someone else already resolved this while you were deciding.",
    );
  });

  test("an already-resolved approval renders calmly with no buttons", async () => {
    const el = await mount(fakeBackend("rejected", true).actions);

    expect(el.querySelectorAll(".chat-block-actions button")).toHaveLength(0);
    expect(el.textContent).toContain("Denied");
  });
});
