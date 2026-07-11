/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval } from "../lib/approvals-api";

const mockListApprovals = mock<() => Promise<Approval[]>>();
const mockApproveRequest = mock<() => Promise<Approval>>();
const mockRejectRequest = mock<() => Promise<Approval>>();

mock.module("../lib/approvals-api", () => ({
  listApprovals: mockListApprovals,
  approveRequest: mockApproveRequest,
  rejectRequest: mockRejectRequest,
}));

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "appr-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    agentId: "agent-1",
    sessionId: "session-1",
    resource: "email://send",
    action: "Send an email to acme@example.com",
    context: null,
    status: "pending",
    message: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  };
}

function renderGate(tenantId = "tenant-1", sessionId?: string) {
  const { ReviewGate } =
    require("./ReviewGate") as typeof import("./ReviewGate");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ReviewGate, { tenantId, sessionId }),
    ),
  );
}

afterEach(() => {
  cleanup();
  mockListApprovals.mockClear();
  mockApproveRequest.mockClear();
  mockRejectRequest.mockClear();
});

describe("ReviewGate — empty state", () => {
  beforeEach(() => {
    mockListApprovals.mockResolvedValue([]);
  });

  it("renders nothing when there are no pending approvals", async () => {
    renderGate();
    // Allow the first poll to settle.
    await waitFor(() => {
      expect(mockListApprovals).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("review-gate")).toBeNull();
  });
});

describe("ReviewGate — pending approvals", () => {
  const pending = makeApproval();

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([pending]);
  });

  it("renders a pending approval with action description and resource", async () => {
    renderGate();
    await waitFor(() => {
      screen.getByTestId("review-gate");
    });
    screen.getByText(pending.action);
    screen.getByText(pending.resource);
  });

  it("renders an Approve button and a Reject button", async () => {
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`approve-${pending.id}`);
    });
    screen.getByTestId(`reject-${pending.id}`);
  });
});

describe("ReviewGate — approve action", () => {
  const pending = makeApproval();
  const approved = makeApproval({
    status: "approved",
    resolvedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    mockListApprovals.mockImplementation(async () => [pending]);
    mockApproveRequest.mockImplementation(async () => {
      mockListApprovals.mockImplementation(async () => [approved]);
      return approved;
    });
  });

  it("calls approveRequest with correct tenantId, approvalId and scope once", async () => {
    renderGate("tenant-1");
    await waitFor(() => {
      screen.getByTestId(`approve-${pending.id}`);
    });

    fireEvent.click(screen.getByTestId(`approve-${pending.id}`));

    await waitFor(() => {
      expect(mockApproveRequest).toHaveBeenCalledWith(
        "tenant-1",
        pending.id,
        "once",
      );
    });
  });

  it("shows the approved status badge after a successful approval", async () => {
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`approve-${pending.id}`);
    });

    fireEvent.click(screen.getByTestId(`approve-${pending.id}`));

    await waitFor(() => {
      screen.getByText("approved");
    });
  });
});

describe("ReviewGate — reject action", () => {
  const pending = makeApproval();
  const rejected = makeApproval({
    status: "rejected",
    resolvedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    mockListApprovals.mockImplementation(async () => [pending]);
    mockRejectRequest.mockImplementation(async () => {
      mockListApprovals.mockImplementation(async () => [rejected]);
      return rejected;
    });
  });

  it("calls rejectRequest with correct tenantId and approvalId", async () => {
    renderGate("tenant-1");
    await waitFor(() => {
      screen.getByTestId(`reject-${pending.id}`);
    });

    fireEvent.click(screen.getByTestId(`reject-${pending.id}`));

    await waitFor(() => {
      expect(mockRejectRequest).toHaveBeenCalledWith("tenant-1", pending.id);
    });
  });

  it("shows the rejected status badge after a successful rejection", async () => {
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`reject-${pending.id}`);
    });

    fireEvent.click(screen.getByTestId(`reject-${pending.id}`));

    await waitFor(() => {
      screen.getByText("rejected");
    });
  });
});

describe("ReviewGate — sessionId filter", () => {
  const matchingSession = makeApproval({
    id: "appr-match",
    sessionId: "sess-target",
  });
  const otherSession = makeApproval({
    id: "appr-other",
    sessionId: "sess-other",
  });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([matchingSession, otherSession]);
  });

  it("shows only approvals matching the given sessionId", async () => {
    renderGate("tenant-1", "sess-target");
    await waitFor(() => {
      screen.getByTestId(`approval-appr-match`);
    });
    expect(screen.queryByTestId("approval-appr-other")).toBeNull();
  });
});

describe("ReviewGate — resolved items reduced opacity", () => {
  const resolved = makeApproval({
    status: "approved",
    resolvedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([resolved]);
  });

  it("renders resolved approvals with reduced opacity class", async () => {
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${resolved.id}`);
    });
    const el = screen.getByTestId(`approval-${resolved.id}`);
    expect(el.className).toContain("opacity-50");
  });
});
