/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { myraInstanceTraceHref } from "./myra-turn-trace";

describe("myraInstanceTraceHref", () => {
  it("returns the instance synthetic principal trace path", () => {
    expect(
      myraInstanceTraceHref("ins_myra", [
        {
          instanceId: "ins_myra",
          principalId: "prn_agent_myra",
          agentId: "agt_myra",
          name: "Myra",
          status: "running",
          sessionCount: 1,
        },
      ]),
    ).toBe("/insights/users/prn_agent_myra");
  });

  it("returns undefined when the instance is not in the roster", () => {
    expect(
      myraInstanceTraceHref("ins_other", [
        {
          instanceId: "ins_myra",
          principalId: "prn_agent_myra",
          agentId: "agt_myra",
          name: "Myra",
          status: "running",
          sessionCount: 1,
        },
      ]),
    ).toBeUndefined();
  });

  it("returns undefined without an instance id", () => {
    expect(myraInstanceTraceHref(null, [])).toBeUndefined();
  });
});