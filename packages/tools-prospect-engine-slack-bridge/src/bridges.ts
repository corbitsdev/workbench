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
import type { ToolCall, ToolDefinition } from "@intx/types/runtime";
import {
  getToolCredential,
  toolCredentialEnvKey,
} from "@workbench/tool-credentials";
import {
  findAgentTool,
  invokeAgentTool,
  withToleranceEnvelope as tolerant,
} from "@workbench/tool-credentials/tolerance-envelope-dispatch";
import { SLACK_HUB_TOOLS } from "@workbench/tools-slack";

function envRecord(env: unknown): Record<string, unknown> {
  return env as Record<string, unknown>;
}

// `tolerant`/`invokeAgentTool`/`findAgentTool` are the shared dispatch
// mechanics from `@workbench/tool-credentials/tolerance-envelope-dispatch`
// (Finding 2, CL-4464 follow-up) — this file, the sumble bridge package, and
// `tools-prospect-engine`'s own `tolerant-bridges.ts` each carried a
// byte-identical local copy before this consolidation.

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

/**
 * Build the real `slack_post_message` tool LAZILY, inside the handler —
 * never at factory-construction time (CL-4454 correctness fix). Resolving
 * the `slack` credential here, inside `tolerant`'s try/catch, means a tenant
 * with no Slack credential configured degrades this bridge's own call
 * instead of the sidecar dropping the whole package and hard-failing the
 * step with `StepToolCredentialMissingError`.
 */
function buildPostSlackTool(env: Record<string, unknown>): AgentTool {
  const credential = getToolCredential(env, "slack");
  const tools = SLACK_HUB_TOOLS.slack_post_message.createTools(credential);
  return findAgentTool(
    tools,
    "slack_post_message",
    "prospect-engine slack bridge",
  );
}

export const prospectEngineSlackBridge: AnnotatedToolFactory = defineTool({
  id: "@workbench/tools-prospect-engine-slack-bridge/post",
  requires: [toolCredentialEnvKey("slack")],
  factory: (env) => {
    const record = envRecord(env);
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
              buildPostSlackTool(record),
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
