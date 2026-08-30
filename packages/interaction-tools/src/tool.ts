// The `ask_user` tool: poses an interview question in-thread as an
// interactive `question` block (`@corbits/chat`'s `blocks.ts`) instead of
// prose bullet options, then structurally parks the turn on a
// `message_response` gate — the reactor neither runs nor answers the call
// until a correlated reply arrives. The answer surfaces as the responding
// user's own next message in this same channel
// (`packages/chat/src/routes.ts`'s question response handling relays it
// there), which clears the gate and becomes the call's tool result. No
// synchronous guess: the turn cannot proceed until it does.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type {
  BeforeToolDecision,
  PendingOperation,
  ToolCall,
  ToolResult,
} from "@intx/types/runtime";
import { type } from "arktype";

import { postQuestion, NoOwnChannelError } from "./client";
import type { AskUserClientConfig } from "./client";

export const ASK_USER_TOOL = "ask_user";

/** How long a posted question waits for an answer before the gate times out
 * and the parked call is answered with a synthetic error. */
export const ASK_USER_TIMEOUT_MS = 3_600_000;

export interface AskUserEnv extends BaseEnv {
  readonly hubChatUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const AskUserInput = type({
  question: "string > 0",
  "subtitle?": "string",
  options: "2 <= string[] <= 6",
  "allowFreeText?": "boolean",
});
type AskUserInput = typeof AskUserInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: AskUserEnv): AskUserClientConfig {
  return {
    hubChatUrl: env.hubChatUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

/**
 * `ask_user`'s `BeforeToolExtension.beforeTool`: posts the question card,
 * then parks the call on a `message_response` gate rather than answering it.
 * The reactor registers the gate and durably persists `pendingOp` before
 * returning to its loop, so the suspension survives a hub restart; it clears
 * only when a correlated reply arrives (or the gate times out).
 */
async function beforeAskUser(
  env: AskUserEnv,
  call: ToolCall,
): Promise<BeforeToolDecision> {
  if (call.name !== ASK_USER_TOOL) {
    return { type: "allow" };
  }

  const parsed = AskUserInput(call.arguments);
  if (parsed instanceof type.errors) {
    return {
      type: "block",
      reason: `${ASK_USER_TOOL} received invalid input: ${parsed.summary}`,
    };
  }

  let questionId: string;
  try {
    ({ questionId } = await postQuestion(clientConfig(env), parsed));
  } catch (err) {
    if (err instanceof NoOwnChannelError) {
      return { type: "block", reason: err.message };
    }
    return {
      type: "block",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // `postQuestion` already mints `questionId` and stamps it on the outbound
  // question card's `data.questionId`; reusing it as the gate's own
  // `correlationId` (rather than minting a second, unrelated id) is what
  // lets the answer route resolve this exact gate later (CL-7191) — the
  // block a person answers is keyed on `blockId`, which for a question
  // block IS `questionId` (`packages/chat/src/schema.ts`'s "agent-authored
  // pollId/formId" comment applies identically here).
  const correlationId = questionId;
  const timeoutAt = Date.now() + ASK_USER_TIMEOUT_MS;
  const gateId = `pending-${correlationId}`;
  const pendingOp: PendingOperation = {
    correlationId,
    kind: "message_response",
    registeredAt: Date.now(),
    gateId,
    timeoutAt,
    suspendedCall: call,
  };

  return {
    type: "suspend",
    gate: { type: "message_response", gateId, correlationId, timeoutAt },
    pendingOp,
  };
}

/**
 * The `@corbits/interaction-tools` bundle factory: one tool, `ask_user`,
 * for posing an enumerable-option interview question as an in-thread card
 * instead of a prose list. No approval gate — showing a question is not an
 * external side effect — but its own `message_response` gate parks the turn
 * until the user answers.
 */
export const interactionTools = defineTool<AskUserEnv>({
  id: "@corbits/interaction-tools/ask-user",
  requires: ["hubChatUrl", "sidecarToken", "address"],
  definitions: [{ name: ASK_USER_TOOL }],
  factory: (env) => ({
    definitions: [
      {
        name: ASK_USER_TOOL,
        description:
          "Asks the user a single interview question with lettered " +
          "options, rendered as an interactive card in the conversation " +
          "instead of a prose list. Use this whenever interviewing the " +
          "user with a small set of enumerable options (2-6), rather " +
          "than writing the options out as text. Parks the turn until " +
          "the user answers: the answer becomes this call's result, not " +
          "a separate message to watch for.",
        inputSchema: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The question's title, e.g. the interview prompt.",
            },
            subtitle: {
              type: "string",
              description: "Optional supporting context shown under the title.",
            },
            options: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 6,
              description: "2-6 answer options, rendered as lettered choices.",
            },
            allowFreeText: {
              type: "boolean",
              description:
                'Whether to also show a "Type your own answer" field. ' +
                "Defaults to false.",
            },
          },
          required: ["question", "options"],
        },
      },
    ],
    beforeToolExtension: {
      beforeTool: (call: ToolCall) => beforeAskUser(env, call),
    },
    run: (call: ToolCall, _signal: AbortSignal) => {
      // `beforeToolExtension` above intercepts every ask_user call and parks
      // it before dispatch ever reaches here; reaching this arm means
      // `interactionTools`'s `beforeToolExtension` was never composed into
      // `ResolvedTools.beforeToolExtensions` (`vendor/intx/agent/src/agent.ts`)
      // — a re-pin or refactor dropped that wiring — not merely "unreachable".
      if (call.name === ASK_USER_TOOL) {
        return Promise.resolve(
          errorResult(
            call.id,
            new Error(
              `${ASK_USER_TOOL}'s beforeToolExtension was not composed ` +
                "into ResolvedTools.beforeToolExtensions — a re-pin or " +
                "refactor dropped the wiring in vendor/intx/agent/src/agent.ts",
            ),
          ),
        );
      }
      return Promise.resolve(
        errorResult(
          call.id,
          new Error(`@corbits/interaction-tools: unknown tool "${call.name}"`),
        ),
      );
    },
  }),
});
