// Shared dispatch mechanics for the CL-4464 tolerance-envelope wrappers
// (Finding 2 in the greybeard review of PR #1310). `tolerant()`,
// `invokeAgentTool()`, and `findAgentTool()` were byte-identical (or
// near-identical) across `@workbench/tools-prospect-engine-sumble-bridge`,
// `@workbench/tools-prospect-engine-slack-bridge`, and
// `@workbench/tools-prospect-engine`'s `tolerant-bridges.ts` — dispatch
// mechanics with zero product-specific variation. This module is the ONE
// shared implementation; every wrapper still owns its own underlying-tool
// call and its own try/catch construction, only the mechanics live here.
//
// Lives in `@workbench/tool-credentials`, not `@workbench/shared` (which may
// import no Interchange internals — see its AGENTS.md) or `@workbench/agents`
// (a much heavier package this file's callers should not need to depend on):
// every tolerant wrapper in the repo already depends on
// `@workbench/tool-credentials` for `getToolCredential`/`getHubRpc`, and this
// package already declares `@intx/agent` and `@intx/types` as dependencies.
//
// The wire shape (`{ isError: true, error }` on failure, raw content on
// success) is defined once in `@workbench/shared`'s `tolerance-envelope.ts`
// and re-exported here alongside the dispatch helpers that produce/consume it.

import type { AgentTool, AgentToolRunner } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import {
  type ToleranceEnvelopeParse,
  parseToleranceEnvelope,
  toleranceFailureContent,
} from "@workbench/shared";

export {
  ToleranceEnvelopeFailureSchema,
  isToleranceEnvelopeFailure,
  parseToleranceEnvelope,
  toleranceFailureContent,
  type ToleranceEnvelopeFailure,
  type ToleranceEnvelopeParse,
} from "@workbench/shared";

function errorMessageFromResult(result: ToolResult): string {
  const { content } = result;
  if (typeof content === "string" && content.length > 0) {
    return content;
  }
  try {
    return JSON.stringify(content);
  } catch {
    return "unknown tool error";
  }
}

/**
 * Run `dispatch`, converting any thrown error or `isError: true` `ToolResult`
 * into a normal (non-error) `ToolResult` whose `content` carries the
 * canonical tolerance-envelope failure shape instead. This is the ONE
 * dispatch mechanic every tolerant wrapper in the repo shares.
 */
export async function withToleranceEnvelope(
  callId: string,
  dispatch: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    const result = await dispatch();
    if (result.isError === true) {
      return {
        callId,
        isError: false,
        content: toleranceFailureContent(errorMessageFromResult(result)),
      };
    }
    return { callId, isError: false, content: result.content };
  } catch (err) {
    return {
      callId,
      isError: false,
      content: toleranceFailureContent(
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
}

/**
 * Dispatch a real underlying `AgentToolRunner` tool call through
 * `withToleranceEnvelope` and parse the result straight into `{ ok, data |
 * error }` — the shape sumble-account-intel's facet/enrich-contacts tools
 * embed directly in their own successful content.
 */
export async function runTolerantTool(
  runner: AgentToolRunner,
  toolName: string,
  callId: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToleranceEnvelopeParse> {
  const result = await withToleranceEnvelope(callId, () =>
    runner.run({ id: callId, name: toolName, arguments: args }, signal),
  );
  return parseToleranceEnvelope(result.content);
}

/** Invoke either kind of `AgentTool` (`full` or `string`) uniformly, always
 * returning a `ToolResult` — shared dispatch mechanics for a bridge that
 * looks up a constructed tool by name and forwards a call to it. */
export async function invokeAgentTool(
  tool: AgentTool,
  call: ToolCall,
  signal: AbortSignal,
): Promise<ToolResult> {
  if (tool.kind === "full") {
    return tool.handler(call, signal);
  }
  const content = await tool.handler(
    (call.arguments ?? {}) as Record<string, unknown>,
    signal,
  );
  return { callId: call.id, isError: false, content };
}

/** Find a constructed `AgentTool` by name, or throw loudly — a tolerant
 * bridge that can't find its own underlying tool is a wiring bug, not a
 * best-effort degrade. */
export function findAgentTool(
  tools: AgentTool[],
  name: string,
  callerLabel: string,
): AgentTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) {
    throw new Error(
      `${callerLabel}: underlying tool "${name}" not constructed`,
    );
  }
  return found;
}
