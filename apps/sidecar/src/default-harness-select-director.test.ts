import { describe, it, expect } from "bun:test";
import { selectDirectorId } from "./default-harness";
import {
  DYNAMIC_TOOLS_DIRECTOR_ID,
  TRIAGE_BUDGET_DIRECTOR_ID,
} from "@workbench/agents";

describe("selectDirectorId", () => {
  it("selects the triage-budget director for a triage session, even with dynamic tool config", () => {
    expect(
      selectDirectorId({ isTriageSession: true, hasDynamicToolConfig: true }),
    ).toBe(TRIAGE_BUDGET_DIRECTOR_ID);
  });

  it("selects the triage-budget director for a triage session without dynamic tool config", () => {
    expect(
      selectDirectorId({ isTriageSession: true, hasDynamicToolConfig: false }),
    ).toBe(TRIAGE_BUDGET_DIRECTOR_ID);
  });

  it("selects the dynamic-tools director for a non-triage session with dynamic tool config", () => {
    expect(
      selectDirectorId({ isTriageSession: false, hasDynamicToolConfig: true }),
    ).toBe(DYNAMIC_TOOLS_DIRECTOR_ID);
  });

  it("selects no director (registry default) for a non-triage, non-dynamic-tools session", () => {
    expect(
      selectDirectorId({
        isTriageSession: false,
        hasDynamicToolConfig: false,
      }),
    ).toBeUndefined();
  });
});
