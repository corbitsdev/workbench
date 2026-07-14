/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { buildApprovalDisplayLookups } from "../lib/approval-display";
import { MailSendApprovalDetails } from "./MailSendApprovalDetails";

const lookups = buildApprovalDisplayLookups(
  [{ id: "prn_ada", name: "Ada Lovelace", refId: "ada" }],
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

afterEach(() => cleanup());

describe("MailSendApprovalDetails", () => {
  it("shows resolved recipient and message without raw instance addresses", () => {
    const view = render(
      React.createElement(MailSendApprovalDetails, {
        context: {
          to: "ins_oat@agents.example.com",
          content: "Hello team",
        },
        lookups,
      }),
    );

    view.getByText("Oat");
    view.getByText("Hello team");
    expect(view.queryByText("ins_oat@agents.example.com")).toBeNull();
  });
});