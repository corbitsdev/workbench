// Tolerant slack bridge for prospect-engine's former `nonFatal` Slack digest
// step (`notify` — CL-4464). Split into its own npm package (rather than
// living inside `@workbench/tools-prospect-engine`) because the tool-
// manifest system pins exactly one credential provider per npm package
// (`packages/tool-manifest/src/derive.ts`'s `derivePackageProviders` throws
// on a package declaring two different providers) — `@workbench/tools-
// prospect-engine`'s own factory is already provider-less (`null`), so a
// slack-credentialed bridge cannot live in the same package.
//
// `ActionPrimitive` has no error-swallow, and `runDeterministicToolStep`
// throws whenever the dispatched tool's outer `ToolResult.isError` is true
// (`step-tool-harness.ts`, unconditionally on the action path). This bridge
// invokes `slack_post_message` in-process (this package declares the
// `slack` credential in its own `requires`, resolved by `buildStepTools`
// exactly like `@workbench/tools-slack`'s own factory) and never lets the
// outer envelope's `isError` become true — a thrown error or an `isError`
// result is caught and turned into a successful outer `ToolResult` whose
// `content` carries `{ isError: true, error }` instead. An absent/empty
// `slackChannelId` skips the post entirely (no channel configured is a
// normal, not a degraded, outcome) — Slack is one delivery destination
// among several, the digest already reached the user's inbox via mail_send.

import {
  type AgentTool,
  type AnnotatedToolFactory,
  createToolRunner,
  defineTool,
} from "@intx/agent";
import type { ToolCall, ToolDefinition, ToolResult } from "@intx/types/runtime";
import {
  getToolCredential,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import { SLACK_HUB_TOOLS } from "@workbench/tools-slack";

function envRecord(env: unknown): Record<string, unknown> {
  return env as Record<string, unknown>;
}

async function tolerant(
  callId: string,
  dispatch: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    const result = await dispatch();
    if (result.isError) {
      return {
        callId,
        isError: false,
        content: {
          isError: true,
          error:
            typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content),
        },
      };
    }
    return { callId, isError: false, content: result.content };
  } catch (err) {
    return {
      callId,
      isError: false,
      content: {
        isError: true,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function invokeAgentTool(
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

function findAgentTool(tools: AgentTool[], name: string): AgentTool {
  const found = tools.find((t) => t.definition.name === name);
  if (found === undefined) {
    throw new Error(
      `prospect-engine slack bridge: underlying tool "${name}" not constructed`,
    );
  }
  return found;
}

export const PROSPECT_ENGINE_POST_SLACK_TOLERANT_DEFINITION: ToolDefinition = {
  name: "prospect_engine_post_slack_tolerant",
  description:
    "Tolerant wrapper over slack_post_message for the nightly prospect-engine digest. Accepts slackChannelId + text verbatim and remaps to slack_post_message's channel/text args. Slack is one delivery destination among several — the digest already reached the user's inbox via mail_send. An absent/empty slackChannelId skips the post entirely (no Slack channel configured); any other failure returns { isError: true, error } instead of throwing.",
  inputSchema: {
    type: "object",
    properties: {
      slackChannelId: { type: "string" },
      text: { type: "string" },
    },
    required: ["text"],
  },
};

export const prospectEngineSlackBridge: AnnotatedToolFactory = defineTool({
  id: "@workbench/tools-prospect-engine-slack-bridge/post",
  requires: [toolCredentialEnvKey("slack")],
  factory: (env) => {
    const credential = getToolCredential(envRecord(env), "slack");
    const tools = SLACK_HUB_TOOLS.slack_post_message.createTools(credential);
    const postTool = findAgentTool(tools, "slack_post_message");
    return createToolRunner([
      {
        kind: "full",
        definition: PROSPECT_ENGINE_POST_SLACK_TOLERANT_DEFINITION,
        handler: async (call: ToolCall, signal: AbortSignal) => {
          const args = (call.arguments ?? {}) as Record<string, unknown>;
          const channel = args.slackChannelId;
          if (typeof channel !== "string" || channel.trim().length === 0) {
            return {
              callId: call.id,
              isError: false,
              content: {
                skipped: true,
                reason: "no slackChannelId configured",
              },
            };
          }
          return tolerant(call.id, () =>
            invokeAgentTool(
              postTool,
              {
                id: call.id,
                name: "slack_post_message",
                arguments: { channel, text: args.text },
              },
              signal,
            ),
          );
        },
      },
    ]);
  },
});
