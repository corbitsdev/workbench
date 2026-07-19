/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { NativeApprovalCard } from "./NativeApprovalCard";
import type { NativeApproval } from "../lib/approvals-api";
import type { UnresolvedToolCall } from "../lib/unresolved-tool-call";

afterEach(() => {
  cleanup();
});

function approval(overrides: Partial<NativeApproval> = {}): NativeApproval {
  return {
    id: "apr-1",
    tenantId: "tnt-1",
    deploymentId: "dep-1",
    runId: "run-1",
    agentAddress: "ins_x@example.com",
    correlationId: "corr-1",
    toolDefinition: null,
    toolArguments: null,
    scope: null,
    status: "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function toolCall(
  overrides: Partial<UnresolvedToolCall> = {},
): UnresolvedToolCall {
  return {
    callId: "call-1",
    name: "linear__create_issue",
    arguments: { title: "Fix login", priority: 2 },
    ...overrides,
  };
}

const noop = () => {};

describe("NativeApprovalCard", () => {
  it("renders the three decision buttons", () => {
    render(
      <NativeApprovalCard
        approval={approval()}
        fallbackToolCall={toolCall()}
        requestState="idle"
        error={null}
        onApprove={noop}
        onReject={noop}
        onAutoApprove={noop}
      />,
    );
    expect(screen.getByText("Approve Once")).toBeDefined();
    expect(screen.getByText("Deny")).toBeDefined();
    expect(screen.getByText("Auto Approve Always")).toBeDefined();
  });

  it("renders humanized argument rows (label + mapped priority)", () => {
    render(
      <NativeApprovalCard
        approval={approval()}
        fallbackToolCall={toolCall({
          arguments: { description: "Investigate the crash", priority: 2 },
        })}
        requestState="idle"
        error={null}
        onApprove={noop}
        onReject={noop}
        onAutoApprove={noop}
      />,
    );
    expect(screen.getByText("Description")).toBeDefined();
    expect(screen.getByText("Investigate the crash")).toBeDefined();
    expect(screen.getByText("Priority")).toBeDefined();
    // Linear priority 2 → "High".
    expect(screen.getByText("High")).toBeDefined();
  });

  it("resolves a team id to a name via resolveId", () => {
    const uuid = "937a3636-1a2b-4c5d-8e9f-0a1b2c3d4e5f";
    render(
      <NativeApprovalCard
        approval={approval()}
        fallbackToolCall={toolCall({
          arguments: { teamId: uuid },
        })}
        requestState="idle"
        error={null}
        onApprove={noop}
        onReject={noop}
        onAutoApprove={noop}
        resolveId={(key) => (key === "teamId" ? "Engineering" : null)}
      />,
    );
    expect(screen.getByText("Team")).toBeDefined();
    expect(screen.getByText("Engineering")).toBeDefined();
  });

  it("confirms then auto-approves with the resolved tool name", () => {
    const onAutoApprove = mock(() => {});
    render(
      <NativeApprovalCard
        approval={approval()}
        fallbackToolCall={toolCall()}
        requestState="idle"
        error={null}
        onApprove={noop}
        onReject={noop}
        onAutoApprove={onAutoApprove}
      />,
    );
    const btn = screen.getByTestId("native-auto-approve-apr-1");
    // First click asks for confirmation, does not fire yet.
    fireEvent.click(btn);
    expect(onAutoApprove).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm — Always Approve")).toBeDefined();
    // Second click fires with the resolved tool name.
    fireEvent.click(screen.getByTestId("native-auto-approve-apr-1"));
    expect(onAutoApprove).toHaveBeenCalledTimes(1);
    expect(onAutoApprove).toHaveBeenCalledWith("linear__create_issue");
  });

  it("disables Auto Approve Always when the tool is unknown", () => {
    render(
      <NativeApprovalCard
        approval={approval()}
        fallbackToolCall={null}
        requestState="idle"
        error={null}
        onApprove={noop}
        onReject={noop}
        onAutoApprove={noop}
      />,
    );
    const btn = screen.getByTestId(
      "native-auto-approve-apr-1",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Approve Once / Deny remain available.
    expect(
      (screen.getByTestId("native-approve-apr-1") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByTestId("native-reject-apr-1") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
