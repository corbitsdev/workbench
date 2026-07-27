import { describe, expect, it } from "bun:test";
import { buildApprovalDisplayLookups } from "./approval-display";
import { createChatToolSummaryFormatter } from "./chat-tool-summary";
import type { AgentInstance } from "./hub-api";
import type { Member } from "../hooks/use-members";

const members: Member[] = [
  { id: "prn_ada", name: "Ada Lovelace", refId: "ada" },
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

describe("createChatToolSummaryFormatter", () => {
  const lookups = buildApprovalDisplayLookups(members, instances);

  it("humanizes mail_send like the approval gate", () => {
    const format = createChatToolSummaryFormatter(lookups, false);
    expect(
      format({
        id: "tc_1",
        name: "mail_send",
        arguments: { to: "usr_ada@example.com", content: "Hi" },
      }),
    ).toBe("Send mail to Ada Lovelace");
  });

  it("shows Recipient while lookups are loading", () => {
    const format = createChatToolSummaryFormatter(lookups, true);
    expect(
      format({
        id: "tc_1",
        name: "mail_send",
        arguments: { to: "usr_ada@example.com" },
      }),
    ).toBe("Send mail to Recipient");
  });

  it("delegates other tools to friendlyToolSummary", () => {
    const format = createChatToolSummaryFormatter(lookups, false);
    expect(
      format({
        id: "tc_1",
        name: "exa__search",
        arguments: { query: "widgets" },
      }),
    ).toBe("Searching the web for widgets");
  });
});
