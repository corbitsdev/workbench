import { describe, expect, test } from "bun:test";
import { HUB_RPC_ENV_KEY } from "@workbench/tool-credentials";
import { workflows } from "./interchange-tools";
import {
  WORKFLOW_LIST_KINDS_DEFINITION,
  WORKFLOW_LIST_RUNS_DEFINITION,
  WORKFLOW_SIGNAL_DEFINITION,
  WORKFLOW_START_DEFINITION,
  WORKFLOW_TOOL_DEFINITIONS,
} from "./definitions";

describe("@workbench/tools-workflows factory", () => {
  test("registers as a hub-backed factory requiring only the hub-RPC context", () => {
    expect(workflows.id).toBe("@workbench/tools-workflows/workflows");
    expect(workflows.requires).toEqual([HUB_RPC_ENV_KEY]);
  });

  test("serves exactly the four workflow-control definitions", () => {
    const ctx = {
      baseURL: "http://hub.test",
      token: "tok",
      tenantId: "tn",
      agentId: "ag",
      principalId: "prn",
      sessionId: "ses",
    };
    const runner = workflows({ [HUB_RPC_ENV_KEY]: ctx } as never);
    expect(runner.definitions.map((d) => d.name)).toEqual([
      "workflow_list_kinds",
      "workflow_start",
      "workflow_list_runs",
      "workflow_signal",
    ]);
  });

  test("addressing params are flat top-level primitives (CL-2319)", () => {
    expect(WORKFLOW_START_DEFINITION.inputSchema.required).toEqual(["kind"]);
    expect(WORKFLOW_SIGNAL_DEFINITION.inputSchema.required).toEqual([
      "runId",
      "signalName",
    ]);
    expect(WORKFLOW_LIST_RUNS_DEFINITION.inputSchema.required).toEqual([]);
    expect(WORKFLOW_LIST_KINDS_DEFINITION.inputSchema.required).toEqual(
      undefined,
    );
    for (const def of WORKFLOW_TOOL_DEFINITIONS) {
      const required = Array.isArray(def.inputSchema.required)
        ? (def.inputSchema.required as string[])
        : [];
      for (const name of required) {
        const prop = (
          def.inputSchema.properties as Record<string, { type?: string }>
        )[name];
        expect(prop?.type === "string" || prop?.type === "boolean").toBe(true);
      }
    }
  });
});
