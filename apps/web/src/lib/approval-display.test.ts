import { describe, expect, it } from "bun:test";
import {
  buildApprovalDisplayLookups,
  formatMailboxAddress,
  humanizeApprovalValue,
} from "./approval-display";
import type { AgentInstance } from "./hub-api";
import type { Member } from "../hooks/use-members";

const members: Member[] = [
  {
    id: "prn_ada",
    name: "Ada Lovelace",
    refId: "ada",
  },
];

const instances: AgentInstance[] = [
  {
    id: "ins_oat",
    agentId: "agt_oat",
    agentName: "Oat",
    tenantId: "tnt_x",
    address: "ins_oat@agents.example.com",
    status: "running",
    credentialRequirements: [],
    capabilities: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("approval-display", () => {
  it("maps agent mailbox addresses to agent names", () => {
    const lookups = buildApprovalDisplayLookups(members, instances);
    expect(formatMailboxAddress("ins_oat@agents.example.com", lookups)).toBe(
      "Oat",
    );
  });

  it("maps user mailbox addresses to member names", () => {
    const lookups = buildApprovalDisplayLookups(members, instances);
    expect(formatMailboxAddress("usr_ada@example.com", lookups)).toBe(
      "Ada Lovelace",
    );
  });

  it("maps bare principal and instance ids", () => {
    const lookups = buildApprovalDisplayLookups(members, instances);
    expect(humanizeApprovalValue("prn_ada", lookups)).toBe("Ada Lovelace");
    expect(humanizeApprovalValue("ins_oat", lookups)).toBe("Oat");
  });

  it("falls back without exposing raw ids when unknown", () => {
    const lookups = buildApprovalDisplayLookups([], []);
    expect(formatMailboxAddress("ins_unknown@x.com", lookups)).toBe("Agent");
    expect(humanizeApprovalValue("prn_unknown", lookups)).toBe("Team member");
  });
});
