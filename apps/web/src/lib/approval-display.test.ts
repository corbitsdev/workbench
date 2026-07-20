import { describe, expect, it } from "bun:test";
import {
  buildApprovalDisplayLookups,
  formatMailboxAddress,
  instanceIdFromAddress,
  mailSendToolSummaryHeadline,
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

  it("falls back without exposing raw ids when unknown", () => {
    const lookups = buildApprovalDisplayLookups([], []);
    expect(formatMailboxAddress("ins_unknown@x.com", lookups)).toBe("Agent");
  });

  it("mailSendToolSummaryHeadline uses Recipient while lookups load", () => {
    const lookups = buildApprovalDisplayLookups(members, instances);
    expect(
      mailSendToolSummaryHeadline("usr_ada@example.com", lookups, true),
    ).toBe("Send mail to Recipient");
  });

  it("mailSendToolSummaryHeadline humanizes the recipient when lookups are ready", () => {
    const lookups = buildApprovalDisplayLookups(members, instances);
    expect(
      mailSendToolSummaryHeadline("usr_ada@example.com", lookups, false),
    ).toBe("Send mail to Ada Lovelace");
    expect(mailSendToolSummaryHeadline(undefined, lookups, false)).toBe(
      "Send mail",
    );
  });

  it("resolves an agent address to its instance id via the exact-address map", () => {
    const lookups = buildApprovalDisplayLookups(members, instances);
    expect(instanceIdFromAddress("ins_oat@agents.example.com", lookups)).toBe(
      "ins_oat",
    );
  });

  it("resolves an ins_ address from its local-part before instances load", () => {
    const lookups = buildApprovalDisplayLookups([], []);
    expect(instanceIdFromAddress("ins_dep-1@agents.example.com", lookups)).toBe(
      "ins_dep-1",
    );
  });

  it("strips a +tag suffix when reading the instance id from the local-part", () => {
    const lookups = buildApprovalDisplayLookups([], []);
    expect(
      instanceIdFromAddress("ins_dep-1+run7@agents.example.com", lookups),
    ).toBe("ins_dep-1");
  });

  it("returns null for a non-ins address that no instance maps", () => {
    const lookups = buildApprovalDisplayLookups([], []);
    expect(
      instanceIdFromAddress("myra@agents.example.com", lookups),
    ).toBeNull();
  });
});
