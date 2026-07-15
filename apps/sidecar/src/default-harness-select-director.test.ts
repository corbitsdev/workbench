import { describe, it, expect } from "bun:test";
import { selectDirectorId } from "./default-harness";
import {
  DYNAMIC_TOOLS_DIRECTOR_ID,
  TRIAGE_BUDGET_DIRECTOR_ID,
  INVOKE_BUDGET_DIRECTOR_ID,
} from "@workbench/agents";

describe("selectDirectorId", () => {
  it("selects the triage-budget director for a triage session, even with dynamic tool config", () => {
    expect(
      selectDirectorId({
        isTriageSession: true,
        isInvokeSession: false,
        hasDynamicToolConfig: true,
      }),
    ).toBe(TRIAGE_BUDGET_DIRECTOR_ID);
  });

  it("selects the triage-budget director for a triage session without dynamic tool config", () => {
    expect(
      selectDirectorId({
        isTriageSession: true,
        isInvokeSession: false,
        hasDynamicToolConfig: false,
      }),
    ).toBe(TRIAGE_BUDGET_DIRECTOR_ID);
  });

  it("selects the invoke-budget director for an invoked-subagent session, even with dynamic tool config", () => {
    expect(
      selectDirectorId({
        isTriageSession: false,
        isInvokeSession: true,
        hasDynamicToolConfig: true,
      }),
    ).toBe(INVOKE_BUDGET_DIRECTOR_ID);
  });

  it("prefers the triage-budget director over the invoke-budget director if both markers are present", () => {
    expect(
      selectDirectorId({
        isTriageSession: true,
        isInvokeSession: true,
        hasDynamicToolConfig: false,
      }),
    ).toBe(TRIAGE_BUDGET_DIRECTOR_ID);
  });

  it("selects the dynamic-tools director for a plain session with dynamic tool config", () => {
    expect(
      selectDirectorId({
        isTriageSession: false,
        isInvokeSession: false,
        hasDynamicToolConfig: true,
      }),
    ).toBe(DYNAMIC_TOOLS_DIRECTOR_ID);
  });

  it("selects no director (registry default) for a plain, non-dynamic-tools session", () => {
    expect(
      selectDirectorId({
        isTriageSession: false,
        isInvokeSession: false,
        hasDynamicToolConfig: false,
      }),
    ).toBeUndefined();
  });
});
