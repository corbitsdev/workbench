import { describe, expect, test } from "bun:test";
import type { AgentTool, AgentToolRunner } from "@intx/agent";
import type { ToolResult } from "@intx/types/runtime";
import {
  findAgentTool,
  invokeAgentTool,
  runTolerantTool,
  withToleranceEnvelope,
} from "./tolerance-envelope-dispatch";

const SIGNAL = new AbortController().signal;

describe("withToleranceEnvelope", () => {
  test("passes through a successful dispatch's content unmodified, isError forced false", async () => {
    const result = await withToleranceEnvelope("c1", async () => ({
      callId: "c1",
      isError: false,
      content: { notes: [{ id: "n1" }] },
    }));
    expect(result).toEqual({
      callId: "c1",
      isError: false,
      content: { notes: [{ id: "n1" }] },
    });
  });

  test("converts an isError:true ToolResult into a completed failure envelope", async () => {
    const result = await withToleranceEnvelope("c2", async () => ({
      callId: "c2",
      isError: true,
      content: "403 forbidden",
    }));
    expect(result).toEqual({
      callId: "c2",
      isError: false,
      content: { isError: true, error: "403 forbidden" },
    });
  });

  test("converts a thrown dispatch error into a completed failure envelope, never rethrows", async () => {
    const result = await withToleranceEnvelope("c3", async () => {
      throw new Error("network down");
    });
    expect(result).toEqual({
      callId: "c3",
      isError: false,
      content: { isError: true, error: "network down" },
    });
  });
});

describe("runTolerantTool", () => {
  function fakeRunner(result: ToolResult): AgentToolRunner {
    return {
      definitions: [],
      run: async () => result,
    } as unknown as AgentToolRunner;
  }

  test("parses a successful runner call into { ok: true, data }", async () => {
    const runner = fakeRunner({
      callId: "",
      isError: false,
      content: { teams: [] },
    });
    const parsed = await runTolerantTool(
      runner,
      "sumble_list_teams",
      "c1",
      { slug: "acme" },
      SIGNAL,
    );
    expect(parsed).toEqual({ ok: true, data: { teams: [] } });
  });

  test("parses a failing runner call into { ok: false, error }", async () => {
    const runner = fakeRunner({
      callId: "",
      isError: true,
      content: "upstream 500",
    });
    const parsed = await runTolerantTool(
      runner,
      "sumble_list_teams",
      "c2",
      { slug: "acme" },
      SIGNAL,
    );
    expect(parsed).toEqual({ ok: false, error: "upstream 500" });
  });
});

describe("invokeAgentTool", () => {
  test("invokes a full-kind tool's handler directly", async () => {
    const tool: AgentTool = {
      kind: "full",
      definition: {
        name: "t",
        description: "d",
        inputSchema: { type: "object" },
      },
      handler: async (call) => ({
        callId: call.id,
        isError: false,
        content: "ok",
      }),
    };
    const result = await invokeAgentTool(
      tool,
      { id: "c1", name: "t", arguments: {} },
      SIGNAL,
    );
    expect(result).toEqual({ callId: "c1", isError: false, content: "ok" });
  });

  test("wraps a string-kind tool's handler into a ToolResult", async () => {
    const tool: AgentTool = {
      kind: "string",
      definition: {
        name: "t",
        description: "d",
        inputSchema: { type: "object" },
      },
      handler: async () => "raw string result",
    };
    const result = await invokeAgentTool(
      tool,
      { id: "c1", name: "t", arguments: {} },
      SIGNAL,
    );
    expect(result).toEqual({
      callId: "c1",
      isError: false,
      content: "raw string result",
    });
  });
});

describe("findAgentTool", () => {
  test("finds a tool by name", () => {
    const tool: AgentTool = {
      kind: "full",
      definition: {
        name: "t",
        description: "d",
        inputSchema: { type: "object" },
      },
      handler: async (call) => ({ callId: call.id, content: "" }),
    };
    expect(findAgentTool([tool], "t", "caller")).toBe(tool);
  });

  test("throws a labeled error when the tool is missing", () => {
    expect(() => findAgentTool([], "missing", "my-bridge")).toThrow(
      /my-bridge: underlying tool "missing" not constructed/,
    );
  });
});
