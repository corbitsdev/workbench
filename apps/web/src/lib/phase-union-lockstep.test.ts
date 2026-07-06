/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { DockRunPhaseSchema, DockStepPhaseSchema } from "@workbench/chat";
import { logRunStateSchema, logStepStateSchema } from "./run-state-adapter";

// The dock's phase unions (packages/blocks/src/run-dock-blocks.ts) and the
// log-state adapter's phase unions (this directory) are maintained by hand in
// two build graphs. These tests fail the moment either union gains or loses a
// member the other lacks, so the drift is caught at test time instead of as a
// silently-dropped phase in the dock.

function unionLiterals(schema: { json: unknown }): Set<string> {
  const branches = Array.isArray(schema.json) ? schema.json : [schema.json];
  return new Set(
    branches.map((branch) => {
      if (
        typeof branch === "object" &&
        branch !== null &&
        "unit" in branch &&
        typeof (branch as { unit: unknown }).unit === "string"
      ) {
        return (branch as { unit: string }).unit;
      }
      throw new Error(
        `Expected a literal union branch, got: ${JSON.stringify(branch)}`,
      );
    }),
  );
}

describe("phase union lockstep (blocks <-> run-state-adapter)", () => {
  it("run phase unions carry exactly the same members", () => {
    expect(unionLiterals(DockRunPhaseSchema)).toEqual(
      unionLiterals(logRunStateSchema.get("phase")),
    );
  });

  it("step phase unions carry exactly the same members", () => {
    expect(unionLiterals(DockStepPhaseSchema)).toEqual(
      unionLiterals(logStepStateSchema.get("phase")),
    );
  });
});
