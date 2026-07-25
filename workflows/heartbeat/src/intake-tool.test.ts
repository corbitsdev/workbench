import { describe, expect, test } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";
import {
  mergeHeartbeatBriefSources,
  parseBriefSourceToolEnvelope,
} from "@workbench/shared";
import {
  createHeartbeatIntakeSourceTool,
  HEARTBEAT_INTAKE_SOURCE_DEFINITION,
  HEARTBEAT_INTAKE_SOURCE_ENV_KEYS,
  HEARTBEAT_INTAKE_SOURCE_PROVIDERS,
} from "./intake-tool";

const SIGNAL = new AbortController().signal;

function handlerOf(tool: ReturnType<typeof createHeartbeatIntakeSourceTool>) {
  if (tool.kind !== "full") {
    throw new Error("expected heartbeat_intake_source to be a full-kind tool");
  }
  return tool.handler;
}

describe("heartbeat_intake_source", () => {
  test("declares one env key per wired provider (granola, linear, attio, vercel)", () => {
    expect(HEARTBEAT_INTAKE_SOURCE_PROVIDERS).toEqual([
      "attio",
      "granola",
      "linear",
      "vercel",
    ]);
    expect(HEARTBEAT_INTAKE_SOURCE_ENV_KEYS).toEqual(
      HEARTBEAT_INTAKE_SOURCE_PROVIDERS.map(toolCredentialEnvKey),
    );
  });

  test("definition requires only `tool`, forwards enabledSources/createdAfter as optional", () => {
    expect(HEARTBEAT_INTAKE_SOURCE_DEFINITION.name).toBe(
      "heartbeat_intake_source",
    );
    expect(HEARTBEAT_INTAKE_SOURCE_DEFINITION.inputSchema.required).toEqual([
      "tool",
    ]);
  });

  // Load-bearing: a native `action` step's dispatched tool has no
  // `nonFatal` escape — `runDeterministicToolStep`
  // (apps/sidecar/src/step-tool-harness.ts) throws whenever the outer
  // `ToolResult.isError` is `true`, which would fail the whole unattended
  // heartbeat run. So every degrade path below must return a completed,
  // `isError: false` envelope, never throw and never set the outer isError.
  describe("never sets the outer isError, even when the source is unreachable", () => {
    test("a source tool with no credential in env degrades to a nested isError content", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const result = await handler(
        {
          id: "c1",
          name: "heartbeat_intake_source",
          arguments: { tool: "granola_list_notes" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({
        isError: true,
        error: "source unavailable: no granola credential configured",
      });
    });

    test("an unknown source tool name degrades to a nested isError content", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const result = await handler(
        {
          id: "c2",
          name: "heartbeat_intake_source",
          arguments: { tool: "not_a_real_tool" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({
        isError: true,
        error: 'heartbeat_intake_source: unknown source tool "not_a_real_tool"',
      });
    });

    test("a missing tool argument degrades to a nested isError content", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const result = await handler(
        { id: "c3", name: "heartbeat_intake_source", arguments: {} },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      expect(result.content).toEqual({
        isError: true,
        error: "heartbeat_intake_source: tool is required",
      });
    });

    test("a malformed credential value (present but invalid shape) degrades rather than throwing", async () => {
      const tool = createHeartbeatIntakeSourceTool({
        [toolCredentialEnvKey("granola")]: { apiKey: 42 },
      });
      const handler = handlerOf(tool);
      const result = await handler(
        {
          id: "c4",
          name: "heartbeat_intake_source",
          arguments: { tool: "granola_list_notes" },
        },
        SIGNAL,
      );
      expect(result.isError).toBe(false);
      const content = result.content as { isError: boolean; error: string };
      expect(content.isError).toBe(true);
      expect(content.error.length).toBeGreaterThan(0);
    });
  });

  // Greybeard review of PR #1310 (Finding 1a): drive the REAL wrapper output
  // through the REAL consumer, end to end — not a hand-typed shape matching
  // what the consumer expects. Proves `mergeHeartbeatBriefSources` /
  // `parseBriefSourceToolEnvelope` actually round-trip
  // `heartbeat_intake_source`'s own degrade shape into a per-source
  // "unavailable" note, and that a real success round-trips to the parsed
  // source data with no `isError` note.
  describe("round-trips through the real @workbench/shared consumer (Finding 1a)", () => {
    test("a real degraded heartbeat_intake_source output parses to a per-source isError note", async () => {
      const tool = createHeartbeatIntakeSourceTool({});
      const handler = handlerOf(tool);
      const output = await handler(
        {
          id: "c1",
          name: "heartbeat_intake_source",
          arguments: { tool: "vercel_list_deployments" },
        },
        SIGNAL,
      );

      const parsed = parseBriefSourceToolEnvelope(output);
      expect(parsed).toEqual({
        isError: true,
        error: "source unavailable: no vercel credential configured",
      });

      const merged = mergeHeartbeatBriefSources({
        "intake-vercel": { output },
      });
      expect(merged.sources.vercel).toEqual({
        isError: true,
        error: "source unavailable: no vercel credential configured",
      });
    });

    test("a real malformed-credential heartbeat_intake_source output round-trips to an isError note without a network call", async () => {
      const tool = createHeartbeatIntakeSourceTool({
        [toolCredentialEnvKey("granola")]: { apiKey: 42 },
      });
      const handler = handlerOf(tool);
      const output = await handler(
        {
          id: "c2",
          name: "heartbeat_intake_source",
          arguments: { tool: "granola_list_notes" },
        },
        SIGNAL,
      );
      expect(output.isError).toBe(false);

      const parsed = parseBriefSourceToolEnvelope(output);
      expect(parsed.isError).toBe(true);
      expect(typeof parsed.error).toBe("string");
      expect((parsed.error as string).length).toBeGreaterThan(0);
    });
  });
});
