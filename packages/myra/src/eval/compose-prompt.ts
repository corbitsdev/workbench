import {
  buildPersonalAgentSystemPrompt,
  PERSONAL_AGENT_PROMPT_VERSION,
} from "../core/prompt";
import {
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_PROMPT_FORMAT,
} from "../core/definition";
import type { ComposeEvalPrompt } from "./runner";

/**
 * Production compose path: the exact provider-formatted personal-agent
 * system prompt, including operator/member context from the case.
 * Kept in its own module so CI runner tests do not import the definition
 * graph (agent-core / tool-manifest).
 */
export const composePersonalAgentEvalPrompt: ComposeEvalPrompt = ({
  caseDef,
}) => {
  const context = caseDef.context ?? {};
  return buildPersonalAgentSystemPrompt(
    PERSONAL_AGENT_NAME,
    PERSONAL_AGENT_PROMPT_FORMAT,
    {
      ...(context.operatorName !== undefined ||
      context.operatorEmail !== undefined
        ? {
            operator: {
              name: context.operatorName ?? "Eval Operator",
              email: context.operatorEmail ?? "eval@example.com",
            },
          }
        : {}),
      ...(context.memberInstructions !== undefined
        ? { instructions: { global: context.memberInstructions } }
        : {}),
      ...(context.model !== undefined ? { model: context.model } : {}),
    },
  );
};

export { PERSONAL_AGENT_PROMPT_VERSION };
