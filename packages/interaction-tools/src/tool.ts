// The `ask_user` tool: poses an interview question in-thread as an
// interactive `question` block (`@corbits/chat`'s `blocks.ts`) instead of
// prose bullet options, then returns immediately — the answer is never
// awaited synchronously. It arrives as the responding user's own next
// message in this same channel (`packages/chat/src/routes.ts`'s question
// response handling relays it there), so the calling agent reads it on its
// next turn exactly like any other reply. Read-only-ish UI action: no
// approval gate, mirroring `list_agents` rather than `create_agent`.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import { postQuestion, NoOwnChannelError } from "./client";
import type { AskUserClientConfig } from "./client";

export const ASK_USER_TOOL = "ask_user";

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

async function runAskUser(
  env: AskUserEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = AskUserInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`${ASK_USER_TOOL} received invalid input: ${parsed.summary}`),
    );
  }

  try {
    await postQuestion(clientConfig(env), parsed);
  } catch (err) {
    if (err instanceof NoOwnChannelError) {
      return errorResult(call.id, err);
    }
    return errorResult(call.id, err);
  }

  return {
    callId: call.id,
    isError: false,
    content:
      "The question has been shown to the user as an interactive card. " +
      "Do not repeat or restate it in prose. Their answer will arrive as " +
      "their next message in this conversation — wait for it rather than " +
      "guessing.",
  };
}

/**
 * The `@corbits/interaction-tools` bundle factory: one tool, `ask_user`,
 * for posing an enumerable-option interview question as an in-thread card
 * instead of a prose list. No approval — showing a question is not an
 * external side effect.
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
          "than writing the options out as text. Returns immediately: " +
          "the user's answer arrives as their next message, not as this " +
          "call's result.",
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
    run: (call: ToolCall, _signal: AbortSignal) => {
      if (call.name !== ASK_USER_TOOL) {
        return Promise.resolve(
          errorResult(
            call.id,
            new Error(
              `@corbits/interaction-tools: unknown tool "${call.name}"`,
            ),
          ),
        );
      }
      return runAskUser(env, call);
    },
  }),
});
