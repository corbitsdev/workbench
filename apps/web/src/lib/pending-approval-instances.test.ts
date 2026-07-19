import { describe, it, expect } from "bun:test";
import { pendingApprovalInstanceIds } from "./pending-approval-instances";
import type { NativeApproval } from "./approvals-api";
import type { AgentInstance } from "./hub-api";

function instance(overrides: Partial<AgentInstance>): AgentInstance {
  return {
    id: "ins_alpha",
    agentId: "agt_1",
    agentName: "Myra",
    tenantId: "tenant-1",
    address: "ins_alpha@agents.example.com",
    status: "active",
    credentialRequirements: [],
    capabilities: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

function approval(overrides: Partial<NativeApproval>): NativeApproval {
  return {
    id: "apr-1",
    tenantId: "tenant-1",
    deploymentId: "dep-1",
    runId: "run-1",
    agentAddress: "ins_alpha@agents.example.com",
    correlationId: "corr-1",
    toolDefinition: null,
    toolArguments: null,
    scope: null,
    status: "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("pendingApprovalInstanceIds", () => {
  it("maps a pending approval to its instance id by full mailbox address", () => {
    const result = pendingApprovalInstanceIds(
      [approval({ agentAddress: "ins_alpha@agents.example.com" })],
      [instance({ id: "ins_alpha", address: "ins_alpha@agents.example.com" })],
    );
    expect(result.has("ins_alpha")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("matches address case-insensitively", () => {
    const result = pendingApprovalInstanceIds(
      [approval({ agentAddress: "INS_Alpha@Agents.Example.com" })],
      [instance({ id: "ins_alpha", address: "ins_alpha@agents.example.com" })],
    );
    expect(result.has("ins_alpha")).toBe(true);
  });

  it("resolves an ins_ mailbox local to a known instance id when the address is not a direct match", () => {
    const result = pendingApprovalInstanceIds(
      [approval({ agentAddress: "ins_beta+run1@other.example.com" })],
      [
        instance({
          id: "ins_beta",
          address: "myra-beta@canonical.example.com",
        }),
      ],
    );
    expect(result.has("ins_beta")).toBe(true);
  });

  it("excludes non-pending approvals", () => {
    const result = pendingApprovalInstanceIds(
      [
        approval({
          agentAddress: "ins_alpha@agents.example.com",
          status: "approved",
        }),
        approval({
          agentAddress: "ins_alpha@agents.example.com",
          status: "rejected",
        }),
      ],
      [instance({ id: "ins_alpha", address: "ins_alpha@agents.example.com" })],
    );
    expect(result.size).toBe(0);
  });

  it("drops approvals whose address maps to no known instance", () => {
    const result = pendingApprovalInstanceIds(
      [approval({ agentAddress: "ins_ghost@agents.example.com" })],
      [instance({ id: "ins_alpha", address: "ins_alpha@agents.example.com" })],
    );
    expect(result.size).toBe(0);
  });

  it("returns an empty set when there are no approvals", () => {
    const result = pendingApprovalInstanceIds(
      [],
      [instance({ id: "ins_alpha" })],
    );
    expect(result.size).toBe(0);
  });

  it("collects multiple distinct instances with pending approvals", () => {
    const result = pendingApprovalInstanceIds(
      [
        approval({ id: "a", agentAddress: "ins_alpha@agents.example.com" }),
        approval({ id: "b", agentAddress: "ins_beta@agents.example.com" }),
      ],
      [
        instance({ id: "ins_alpha", address: "ins_alpha@agents.example.com" }),
        instance({ id: "ins_beta", address: "ins_beta@agents.example.com" }),
      ],
    );
    expect(result.has("ins_alpha")).toBe(true);
    expect(result.has("ins_beta")).toBe(true);
    expect(result.size).toBe(2);
  });
});
