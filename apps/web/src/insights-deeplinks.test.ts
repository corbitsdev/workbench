import { describe, expect, test } from "bun:test";

import type { WorkflowRun } from "./api";
import {
  ROUTINES_PATH_PREFIX,
  runDeepLinkTarget,
  runDetailPath,
} from "./insights-deeplinks";

function run(id: string): WorkflowRun {
  return {
    id,
    tenantId: "t1",
    tenantName: "Bench",
    definitionId: "def",
    definitionName: "research-brief",
    address: "addr",
    status: "running",
    createdAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("runDetailPath", () => {
  test("builds the /routines/:id run-detail path the command palette also uses", () => {
    expect(runDetailPath("run_123")).toBe(`${ROUTINES_PATH_PREFIX}/run_123`);
  });

  test("encodes ids so a slash or space cannot break out of the segment", () => {
    expect(runDetailPath("a/b c")).toBe(`${ROUTINES_PATH_PREFIX}/a%2Fb%20c`);
  });
});

describe("runDeepLinkTarget", () => {
  test("returns the run-detail path for a purpose run", () => {
    expect(runDeepLinkTarget(run("run_42"))).toBe(
      `${ROUTINES_PATH_PREFIX}/run_42`,
    );
  });

  test("is stable across two runs that differ only by id", () => {
    expect(runDeepLinkTarget(run("a"))).not.toBe(runDeepLinkTarget(run("b")));
  });
});
