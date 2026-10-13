import { describe, expect, test } from "bun:test";

import { turnSettled } from "./worker-status";

const WORKER = "run_live@bench.localhost";
const SENT_AT = Date.parse("2026-10-13T12:00:00Z");

function pendingAsk(agentAddress: string) {
  return {
    id: `apr_${agentAddress}`,
    tenantId: "tnt_bench",
    anchorRunId: "run_anchor",
    runId: "run_anchor",
    agentAddress,
    correlationId: "corr",
    toolDefinition: { name: "run_shell" },
    toolArguments: { command: "echo hi" },
    scope: null,
    status: "pending" as const,
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-10-13T11:00:00Z",
    updatedAt: "2026-10-13T11:00:00Z",
  };
}

describe("turnSettled", () => {
  test("an ask left pending by a stopped run does not end the live worker's turn", () => {
    const orphan = pendingAsk("run_gone@bench.localhost");
    expect(turnSettled(SENT_AT, [], [orphan], WORKER)).toBe(false);
  });

  test("the live worker parking on an ask ends the turn", () => {
    expect(turnSettled(SENT_AT, [], [pendingAsk(WORKER.toUpperCase())], WORKER)).toBe(true);
  });
});
