// DOM tests for the approve card's live round-trip. The host port
// (`ApprovalActions`) is the mock boundary — a fake implementation stands in
// for the host's fetch-backed reads/writes, the same way the block never
// talks to `fetch` itself. Covers: pending+actable, pending+spectator,
// approve success (through to the invalidation callback the host's real
// port would run), approve failure (no fake resolution), and an
// already-resolved render.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  ApprovalActions,
  ApprovalDecisionResult,
  ApprovalStatusQuery,
} from "../src/blocks/approval-actions";
import type { MessageItem } from "../src/api";
import { ChannelTimeline } from "../src/timeline";

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
              title: "Deploy staging",
              risk: "high",
              body: "Rolls out the ingest worker.",
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
    const calls: string[] = [];
    const el = await mount(
      fakeActions({
        getStatus: async () => ({
          kind: "ready",
          status: "pending",
          canAct: true,
        }),
        approve: async (id) => {
          calls.push(id);
          return { kind: "resolved", status: "approved" };
        },
      }),
    );

    const buttons = el.querySelectorAll(".chat-block-action");
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });

    expect(calls).toEqual(["apv_1"]);
    expect(el.textContent).toContain("Approved");
  });

  test("pending + spectator: status shown, no buttons", async () => {
    const el = await mount(
      fakeActions({
        getStatus: async () => ({
          kind: "ready",
          status: "pending",
          canAct: false,
        }),
      }),
    );

    expect(el.querySelectorAll(".chat-block-action")).toHaveLength(0);
    expect(el.textContent).toContain(
      "Only an approver on this bench can act on this.",
    );
  });

  test("approve success re-renders resolved state from the port's response and invalidates", async () => {
    let invalidated = false;
    const el = await mount(
      fakeActions({
        getStatus: async () => ({
          kind: "ready",
          status: "pending",
          canAct: true,
        }),
        approve: async () => {
          invalidated = true; // stands in for the host's queryClient.invalidateQueries
          return { kind: "resolved", status: "approved" };
        },
      }),
    );

    const approveButton = el.querySelector(
      ".chat-block-action[data-primary]",
    ) as HTMLButtonElement;
    await act(async () => {
      approveButton.click();
    });

    expect(invalidated).toBe(true);
    expect(el.querySelectorAll(".chat-block-action")).toHaveLength(0);
    expect(el.textContent).toContain("Approved");
  });

  test("approve failure shows an error and never fakes resolution", async () => {
    const el = await mount(
      fakeActions({
        getStatus: async () => ({
          kind: "ready",
          status: "pending",
          canAct: true,
        }),
        approve: async () => ({
          kind: "error",
          message: "network down",
        }),
      }),
    );

    const approveButton = el.querySelector(
      ".chat-block-action[data-primary]",
    ) as HTMLButtonElement;
    await act(async () => {
      approveButton.click();
    });

    expect(el.textContent).toContain("Couldn't reach the approval");
    expect(el.textContent).not.toContain("Approved");
    // Buttons remain — the approval is still pending, not silently resolved.
    expect(el.querySelectorAll(".chat-block-action")).toHaveLength(2);
  });

  test("an already-resolved approval renders calmly with no buttons", async () => {
    const el = await mount(
      fakeActions({
        getStatus: async () => ({
          kind: "ready",
          status: "rejected",
          canAct: true,
        }),
      }),
    );

    expect(el.querySelectorAll(".chat-block-action")).toHaveLength(0);
    expect(el.textContent).toContain("Denied");
  });

  test("a forbidden status read renders buttons anyway and surfaces a 403 inline on click", async () => {
    const el = await mount(
      fakeActions({
        getStatus: async () => ({ kind: "forbidden" }),
        approve: async () => ({
          kind: "forbidden",
          message: "nope",
        }),
      }),
    );

    const buttons = el.querySelectorAll(".chat-block-action");
    expect(buttons).toHaveLength(2);

    await act(async () => {
      (buttons[0] as HTMLButtonElement).click();
    });

    expect(el.textContent).toContain(
      "You do not have permission to act on this.",
    );
  });
});
