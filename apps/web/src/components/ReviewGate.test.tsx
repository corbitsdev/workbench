/// <reference types="bun" />
import "../test-setup";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalEvent, NativeApproval } from "../lib/approvals-api";

const mockListNativeApprovals = mock<() => Promise<NativeApproval[]>>();
const mockApproveNativeRequest = mock<() => Promise<NativeApproval>>();
const mockRejectNativeRequest = mock<() => Promise<NativeApproval>>();

// Captures the ReviewGate's event handler so a test can simulate an SSE
// approval event. subscribeApprovals returns an unsubscribe function.
let capturedOnEvent: ((event: ApprovalEvent) => void) | null = null;
const subscribeCalls: string[] = [];
let unsubscribeCalls = 0;
const mockSubscribeApprovals = mock(
  (tenantId: string, onEvent: (event: ApprovalEvent) => void) => {
    subscribeCalls.push(tenantId);
    capturedOnEvent = onEvent;
    return () => {
      unsubscribeCalls += 1;
      capturedOnEvent = null;
    };
  },
);

mock.module("../lib/approvals-api", () => ({
  subscribeApprovals: mockSubscribeApprovals,
  listNativeApprovals: mockListNativeApprovals,
  approveNativeRequest: mockApproveNativeRequest,
  rejectNativeRequest: mockRejectNativeRequest,
}));

function renderGate(tenantId = "tenant-1") {
  const { ReviewGate } =
    require("./ReviewGate") as typeof import("./ReviewGate");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ReviewGate, { tenantId }),
    ),
  );
}

function makeNativeApproval(
  overrides: Partial<NativeApproval> = {},
): NativeApproval {
  return {
    id: "apr-native-1",
    tenantId: "tenant-1",
    deploymentId: "dep-1",
    runId: "run-1",
    agentAddress: "ins_dep-1@agents.example.com",
    correlationId: "corr-1",
    toolDefinition: null,
    toolArguments: null,
    scope: null,
    status: "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// React Query rejects an undefined queryFn result, so a default must be set
// before every render.
beforeEach(() => {
  mockListNativeApprovals.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  mockSubscribeApprovals.mockClear();
  mockListNativeApprovals.mockReset();
  mockApproveNativeRequest.mockClear();
  mockRejectNativeRequest.mockClear();
  subscribeCalls.length = 0;
  unsubscribeCalls = 0;
  capturedOnEvent = null;
});

describe("ReviewGate — event-driven refresh", () => {
  it("subscribes to the approvals event stream for the tenant on mount", async () => {
    renderGate("tenant-42");
    await waitFor(() => {
      expect(mockSubscribeApprovals).toHaveBeenCalled();
    });
    expect(subscribeCalls).toContain("tenant-42");
  });

  it("does not poll on an interval — an idle gate fetches once", async () => {
    jest.useFakeTimers();
    try {
      renderGate();
      for (let i = 0; i < 10; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(mockListNativeApprovals).toHaveBeenCalledTimes(1);
      // Advance well past any legacy poll interval. Event-driven code schedules
      // no refetch, so the count must not move.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(mockListNativeApprovals).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("refetches when a created event arrives, surfacing a new approval", async () => {
    const pending = makeNativeApproval();
    renderGate();
    await waitFor(() => {
      expect(mockListNativeApprovals).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("review-gate")).toBeNull();

    mockListNativeApprovals.mockResolvedValue([pending]);
    act(() => {
      capturedOnEvent?.({
        tenantId: "tenant-1",
        sessionId: null,
        kind: "created",
      });
    });

    await waitFor(() => {
      screen.getByTestId(`native-approval-${pending.id}`);
    });
  });

  it("refetches when a resolved event arrives, clearing the gate", async () => {
    const pending = makeNativeApproval();
    mockListNativeApprovals.mockResolvedValue([pending]);
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`native-approval-${pending.id}`);
    });

    mockListNativeApprovals.mockResolvedValue([]);
    act(() => {
      capturedOnEvent?.({
        tenantId: "tenant-1",
        sessionId: null,
        kind: "resolved",
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("review-gate")).toBeNull();
    });
  });
});

describe("ReviewGate — empty state", () => {
  it("renders nothing when there are no pending approvals", async () => {
    renderGate();
    await waitFor(() => {
      expect(mockListNativeApprovals).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("review-gate")).toBeNull();
  });

  it("renders nothing when the list fetch fails and there are none", async () => {
    mockListNativeApprovals.mockRejectedValue(new Error("network is down"));
    const { container } = renderGate();
    await waitFor(() => {
      expect(mockListNativeApprovals).toHaveBeenCalledTimes(1);
    });
    // A failed background fetch must degrade quietly: no gate container, and no
    // red error banner painted over the composer.
    expect(screen.queryByTestId("review-gate")).toBeNull();
    expect(container.querySelector(".bg-red-soft")).toBeNull();
    expect(container.textContent).not.toContain("network is down");
  });
});

describe("ReviewGate — native rail", () => {
  it("renders a friendly action label derived from the tool snapshot", async () => {
    mockListNativeApprovals.mockResolvedValue([
      makeNativeApproval({
        toolDefinition: { name: "slack__post_message" },
        toolArguments: { channel: "#gtm", text: "hi" },
      }),
    ]);
    renderGate();
    await waitFor(() => {
      screen.getByTestId("native-approval-apr-native-1");
    });
    // The friendly catalog label, never the raw snake_case id and never the
    // "Approval requested by <agent>" fallback.
    screen.getByText("Posting to Slack #gtm");
    expect(screen.queryByText("slack__post_message")).toBeNull();
  });

  it("falls back to the originating agent when no tool snapshot exists", async () => {
    mockListNativeApprovals.mockResolvedValue([makeNativeApproval()]);
    renderGate();
    await waitFor(() => {
      screen.getByTestId("native-approval-apr-native-1");
    });
    screen.getByText(/Approval requested by ins_dep-1/);
  });

  it("summarizes tool arguments as key: value pairs when the snapshot carries them", async () => {
    mockListNativeApprovals.mockResolvedValue([
      makeNativeApproval({
        toolDefinition: { name: "slack__post_message" },
        toolArguments: { channel: "#gtm", text: "hi" },
      }),
    ]);
    renderGate();
    await waitFor(() => {
      screen.getByTestId("native-approval-apr-native-1");
    });
    // Values, not just field names, so the approver sees what will actually run.
    screen.getByText("channel: #gtm · text: hi");
  });

  it("resolves a native approval through the native approve route", async () => {
    mockListNativeApprovals.mockResolvedValue([makeNativeApproval()]);
    mockApproveNativeRequest.mockResolvedValue(
      makeNativeApproval({ status: "approved" }),
    );
    renderGate();
    const approve = await waitFor(() =>
      screen.getByTestId("native-approve-apr-native-1"),
    );
    fireEvent.click(approve);
    await waitFor(() => {
      expect(mockApproveNativeRequest).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a native approval through the native reject route", async () => {
    mockListNativeApprovals.mockResolvedValue([makeNativeApproval()]);
    mockRejectNativeRequest.mockResolvedValue(
      makeNativeApproval({ status: "rejected" }),
    );
    renderGate();
    const reject = await waitFor(() =>
      screen.getByTestId("native-reject-apr-native-1"),
    );
    fireEvent.click(reject);
    await waitFor(() => {
      expect(mockRejectNativeRequest).toHaveBeenCalledTimes(1);
    });
  });

  it("surfaces a per-item error when the user's approve action fails", async () => {
    mockListNativeApprovals.mockResolvedValue([makeNativeApproval()]);
    mockApproveNativeRequest.mockRejectedValue(new Error("could not approve"));
    renderGate();
    const approve = await waitFor(() =>
      screen.getByTestId("native-approve-apr-native-1"),
    );
    fireEvent.click(approve);
    await waitFor(() => {
      screen.getByText("could not approve");
    });
  });

  it("orders multiple pending approvals newest-first by createdAt", async () => {
    mockListNativeApprovals.mockResolvedValue([
      makeNativeApproval({
        id: "native-old",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeNativeApproval({
        id: "native-new",
        createdAt: "2026-06-01T00:00:00.000Z",
      }),
    ]);
    renderGate();
    const gate = await waitFor(() => screen.getByTestId("review-gate"));
    const order = Array.from(
      gate.querySelectorAll("[data-testid^='native-approval-']"),
    ).map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual([
      "native-approval-native-new",
      "native-approval-native-old",
    ]);
  });
});

describe("ReviewGate — subscription teardown", () => {
  it("unsubscribes from the stream on unmount", async () => {
    const view = renderGate();
    await waitFor(() => {
      expect(mockListNativeApprovals).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockSubscribeApprovals).toHaveBeenCalled();
    });
    expect(unsubscribeCalls).toBe(0);

    view.unmount();

    expect(unsubscribeCalls).toBe(1);
  });
});
