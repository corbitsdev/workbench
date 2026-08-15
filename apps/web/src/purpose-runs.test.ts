import { describe, expect, test } from "bun:test";

import type { WorkflowRun } from "./api";
import { purposeRuns } from "./purpose-runs";

function run(
  partial: Partial<WorkflowRun> & Pick<WorkflowRun, "id" | "status">,
): WorkflowRun {
  return {
    tenantId: "t1",
    tenantName: "Bench",
    definitionId: "def",
    definitionName: partial.definitionName ?? "research-brief",
    address: "addr",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...partial,
  };
}

describe("purposeRuns", () => {
  const channelHost = run({
    id: "host",
    status: "running",
    definitionName: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  });
  const invitedAgent = run({
    id: "ins_invited",
    status: "running",
    definitionName: "Researcher",
  });
  const deployment = run({ id: "ins_deployed", status: "running" });

  test("drops a channel-host run with no folded-run-id set given", () => {
    expect(purposeRuns([deployment, channelHost])).toEqual([deployment]);
  });

  test("drops an invited-agent run under a real definitionId when its id is in the folded-run-id set", () => {
    const result = purposeRuns(
      [deployment, invitedAgent],
      new Set([invitedAgent.id]),
    );
    expect(result).toEqual([deployment]);
  });

  test("leaves an ordinary top-level deployment run alone", () => {
    const result = purposeRuns([deployment], new Set([invitedAgent.id]));
    expect(result).toEqual([deployment]);
  });
});
