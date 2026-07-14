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
import type { Approval, ApprovalEvent } from "../lib/approvals-api";

const mockListApprovals = mock<() => Promise<Approval[]>>();
const mockApproveRequest = mock<() => Promise<Approval>>();
const mockRejectRequest = mock<() => Promise<Approval>>();

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
  listApprovals: mockListApprovals,
  approveRequest: mockApproveRequest,
  rejectRequest: mockRejectRequest,
  subscribeApprovals: mockSubscribeApprovals,
}));

import { buildApprovalDisplayLookups } from "../lib/approval-display";

const approvalDisplayLookups = buildApprovalDisplayLookups(
  [
    {
      id: "prn_ada",
      name: "Ada Lovelace",
      refId: "ada",
    },
  ],
  [
    {
      id: "ins_oat",
      agentId: "agt_oat",
      agentName: "Oat",
      tenantId: "tenant-1",
      address: "ins_oat@agents.example.com",
      status: "running",
      credentialRequirements: [],
      capabilities: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
);

let mockApprovalLookupsLoading = false;

mock.module("../hooks/use-approval-display-lookups", () => ({
  useApprovalDisplayLookups: () => ({
    lookups: mockApprovalLookupsLoading
      ? buildApprovalDisplayLookups([], [])
      : approvalDisplayLookups,
    isLoading: mockApprovalLookupsLoading,
  }),
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
  mockApprovalLookupsLoading = false;
  mockListApprovals.mockClear();
  mockApproveRequest.mockClear();
  mockRejectRequest.mockClear();
  mockSubscribeApprovals.mockClear();
  subscribeCalls.length = 0;
  unsubscribeCalls = 0;
  capturedOnEvent = null;
});

describe("ReviewGate — event-driven refresh", () => {
  it("subscribes to the approvals event stream for the tenant on mount", async () => {
    mockListApprovals.mockResolvedValue([]);
    renderGate("tenant-42");
    await waitFor(() => {
      expect(mockSubscribeApprovals).toHaveBeenCalled();
    });
    expect(subscribeCalls).toContain("tenant-42");
  });

  it("does not poll on an interval — an idle gate fetches once", async () => {
    jest.useFakeTimers();
    try {
      mockListApprovals.mockResolvedValue([]);
      renderGate();
      // Flush the initial query's microtasks so the first fetch lands.
      for (let i = 0; i < 10; i += 1) {
        await act(async () => {
          await Promise.resolve();
        });
      }
      expect(mockListApprovals).toHaveBeenCalledTimes(1);
      // Advance well past any legacy poll interval (3s / 8s). Event-driven code
      // schedules no refetch, so the count must not move.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(mockListApprovals).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("refetches when a created event arrives, surfacing a new approval", async () => {
    const pending = makeApproval();
    mockListApprovals.mockResolvedValue([]);
    renderGate();
    await waitFor(() => {
      expect(mockListApprovals).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("review-gate")).toBeNull();

    mockListApprovals.mockResolvedValue([pending]);
    act(() => {
      capturedOnEvent?.({
        tenantId: "tenant-1",
        sessionId: null,
        kind: "created",
      });
    });

    await waitFor(() => {
      screen.getByTestId(`approval-${pending.id}`);
    });
  });

  it("refetches when a resolved event arrives, clearing the gate", async () => {
    const pending = makeApproval();
    mockListApprovals.mockResolvedValue([pending]);
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${pending.id}`);
    });

    mockListApprovals.mockResolvedValue([]);
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

describe("ReviewGate — humanized context", () => {
  const withContext = makeApproval({
    resource: "tool:notion__create_page",
    action: "Run notion__create_page",
    context: { document_title: "Q3 report", draft: true },
  });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([withContext]);
  });

  it("renders context arguments as humanized key/value rows, not raw JSON", async () => {
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${withContext.id}`);
    });

    // Snake_case keys are humanized into readable labels and values shown plainly.
    screen.getByText("Document Title");
    screen.getByText("Q3 report");
    screen.getByText("Draft");
    screen.getByText("true");
    // The raw JSON stringification must not leak into the DOM.
    expect(container.textContent).not.toContain('"document_title"');
  });

  it("renders a friendly humanized headline for a known tool resource", async () => {
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${withContext.id}`);
    });
    // friendlyToolSummary maps notion create_page to a human verb phrase; the
    // raw operation id must not be the headline.
    expect(screen.queryByText("Run notion__create_page")).not.toBeNull();
    screen.getByText(/notion page/i);
  });

  it("falls back to the backend action headline for an unrecognized tool", async () => {
    const unknown = makeApproval({
      resource: "tool:totally_unknown_xyz_tool",
      action: "Perform the specific unknown operation",
      context: {},
    });
    mockListApprovals.mockResolvedValue([unknown]);
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${unknown.id}`);
    });
    // Unrecognized tool: friendlyToolSummaryKnown returns null, so the headline
    // is the backend action — never the soft "Working on …" fallback label.
    expect(container.textContent).toContain(
      "Perform the specific unknown operation",
    );
    expect(container.textContent).not.toContain("Working on");
  });

  it("shows a friendly tool caption instead of a semi-raw tool resource id", async () => {
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${withContext.id}`);
    });
    expect(container.textContent).not.toContain("tool:notion__create_page");
    expect(container.textContent).not.toContain("notion · create_page");
    screen.getByText("Creating a Notion page");
  });
});

describe("ReviewGate — tool:mail_send headline", () => {
  const mailSend = makeApproval({
    resource: "tool:mail_send",
    action: "Send mail",
    context: {
      to: "usr_ada@example.com",
      content: "Hello",
      subject: "Hi",
    },
  });

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([mailSend]);
  });

  it("shows a neutral recipient placeholder while display lookups are loading", async () => {
    mockApprovalLookupsLoading = true;
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${mailSend.id}`);
    });
    screen.getByText("Send mail to Recipient");
    expect(container.textContent).not.toContain("usr_ada");
    expect(container.textContent).not.toContain("usr_");
  });

  it("humanizes the recipient in the headline once lookups resolve", async () => {
    mockApprovalLookupsLoading = false;
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${mailSend.id}`);
    });
    screen.getByText("Send mail to Ada Lovelace");
    expect(container.textContent).not.toContain("usr_ada@example.com");
  });

  it("omits a secondary resource caption for mail send approvals", async () => {
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${mailSend.id}`);
    });
    expect(container.textContent).not.toContain("tool:mail_send");
    expect(container.textContent).not.toContain("mail · send");
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

  it("calls approveRequest with only tenantId and approvalId", async () => {
    renderGate("tenant-1");
    await waitFor(() => {
      screen.getByTestId(`approve-${pending.id}`);
    });

    fireEvent.click(screen.getByTestId(`approve-${pending.id}`));

    await waitFor(() => {
      expect(mockApproveRequest).toHaveBeenCalledWith("tenant-1", pending.id);
    });
    const call = mockApproveRequest.mock.calls[0];
    expect(call).toHaveLength(2);
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

  it("shows nothing when session scope is required but sessionId is unknown", async () => {
    const { ReviewGate } =
      require("./ReviewGate") as typeof import("./ReviewGate");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ReviewGate, {
          tenantId: "tenant-1",
          sessionScope: "session",
        }),
      ),
    );
    await waitFor(() => expect(mockListApprovals).not.toHaveBeenCalled());
    expect(screen.queryByTestId("review-gate")).toBeNull();
  });
});

describe("ReviewGate — large context values", () => {
  it("truncates a long non-HTML string and expands on demand", async () => {
    const longBody = `Note body ${"x".repeat(400)}`;
    const approval = makeApproval({
      resource: "tool:notes__create",
      action: "Run notes__create",
      context: { body: longBody, title: "Short title" },
    });
    mockListApprovals.mockResolvedValue([approval]);
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${approval.id}`);
    });

    // Short metadata stays fully visible.
    screen.getByText("Short title");
    // Long body is truncated in the initial render — the full string must not
    // appear unbroken as one dump (the expand control is the only path to it).
    expect(container.textContent).not.toContain(longBody);
    screen.getByTestId("context-truncated-value");
    const expand = screen.getByRole("button", { name: /show more/i });
    fireEvent.click(expand);
    expect(container.textContent).toContain(longBody);
    fireEvent.click(screen.getByRole("button", { name: /show less/i }));
    expect(container.textContent).not.toContain(longBody);
  });

  it("renders HTML args as a sandboxed preview instead of a raw dump", async () => {
    const html = `<!DOCTYPE html><html lang="en"><head><title>Tap Tap</title></head><body><h1>Tap Tap Workbench</h1><p>${"play".repeat(80)}</p></body></html>`;
    const approval = makeApproval({
      resource: "tool:vercel__deploy_static_file",
      action: "Run vercel__deploy_static_file",
      context: {
        html,
        projectName: "tap-tap-workbench",
        fileName: "index.html",
      },
    });
    mockListApprovals.mockResolvedValue([approval]);
    const { container } = renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${approval.id}`);
    });

    // Short deploy metadata stays scannable.
    screen.getByText("tap-tap-workbench");
    screen.getByText("index.html");
    // The raw HTML document is NOT dumped as unbroken text in the card.
    expect(container.textContent).not.toContain("<!DOCTYPE html>");
    const preview = screen.getByTestId("context-html-preview");
    const frame = preview.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame?.getAttribute("srcdoc") ?? frame?.getAttribute("srcDoc")).toBe(
      html,
    );
    // Size summary is visible so the operator knows what they are approving.
    expect(preview.textContent).toMatch(/HTML/i);
    expect(preview.textContent).toMatch(/KB|chars/i);
  });

  it("detects HTML after a leading comment and uses the preview path", async () => {
    const html = `<html><body><p>deploy</p></body></html>`;
    const approval = makeApproval({
      resource: "tool:vercel__deploy_static_file",
      action: "Run vercel__deploy_static_file",
      context: {
        html: `<!-- generated -->\n${html}`,
        projectName: "demo",
      },
    });
    mockListApprovals.mockResolvedValue([approval]);
    renderGate();
    await waitFor(() => {
      screen.getByTestId("context-html-preview");
    });
    expect(screen.queryByTestId("context-truncated-value")).toBeNull();
  });
});

describe("ReviewGate — background poll failure", () => {
  beforeEach(() => {
    mockListApprovals.mockRejectedValue(new Error("network is down"));
  });

  it("renders nothing when the approvals poll fails and there are none", async () => {
    const { container } = renderGate();
    await waitFor(() => {
      expect(mockListApprovals).toHaveBeenCalledTimes(1);
    });
    // A failed background poll must degrade quietly: no gate container, and
    // crucially no red error banner painted over the composer.
    expect(screen.queryByTestId("review-gate")).toBeNull();
    expect(container.querySelector(".bg-red-soft")).toBeNull();
    expect(container.textContent).not.toContain("network is down");
  });
});

describe("ReviewGate — user-initiated action failure", () => {
  const pending = makeApproval();

  beforeEach(() => {
    mockListApprovals.mockResolvedValue([pending]);
    mockApproveRequest.mockRejectedValue(new Error("could not approve"));
  });

  it("surfaces a per-item error when the user's approve action fails", async () => {
    renderGate("tenant-1");
    await waitFor(() => {
      screen.getByTestId(`approve-${pending.id}`);
    });

    fireEvent.click(screen.getByTestId(`approve-${pending.id}`));

    await waitFor(() => {
      screen.getByText("could not approve");
    });
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

  it("presents resolved approvals as dimmed, action-free status only", async () => {
    renderGate();
    await waitFor(() => {
      screen.getByTestId(`approval-${resolved.id}`);
    });
    const el = screen.getByTestId(`approval-${resolved.id}`);
    // The dead Tailwind dimming class was removed; opacity is the animate target.
    expect(el.className).not.toContain("opacity-50");
    // Resolved rows show the status badge and expose no approve/reject actions.
    screen.getByText("approved");
    expect(screen.queryByTestId(`approve-${resolved.id}`)).toBeNull();
    expect(screen.queryByTestId(`reject-${resolved.id}`)).toBeNull();
  });
});

describe("ReviewGate — subscription teardown", () => {
  it("unsubscribes from the stream on unmount", async () => {
    mockListApprovals.mockResolvedValue([]);
    const view = renderGate();
    // Let the initial list query settle before unmounting so no in-flight
    // promise resolves against an unmounted tree and bleeds into later tests.
    await waitFor(() => {
      expect(mockListApprovals).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockSubscribeApprovals).toHaveBeenCalled();
    });
    expect(unsubscribeCalls).toBe(0);

    view.unmount();

    expect(unsubscribeCalls).toBe(1);
  });
});
