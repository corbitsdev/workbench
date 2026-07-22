import {
  buildPersonalAgentSystemPrompt,
  buildPersonalAgentSystemPromptV2,
  PERSONAL_AGENT_PROMPT_VERSION,
  PERSONAL_AGENT_PROMPT_VERSION_V2,
  type MyraPromptGeneration,
} from "../core/prompts";
import {
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_PROMPT_FORMAT,
} from "../core/definition";
import type { EvalCase } from "./case";
import type { ComposeEvalPrompt } from "./runner";

/** Fallback model label so v2 (which requires `model`) always has a value. */
const EVAL_DEFAULT_MODEL = "eval-model";

function operatorFromContext(
  context: EvalCase["context"],
): { name: string; email: string } | undefined {
  const ctx = context ?? {};
  if (ctx.operatorName === undefined && ctx.operatorEmail === undefined) {
    return undefined;
  }
  return {
    name: ctx.operatorName ?? "Eval Operator",
    email: ctx.operatorEmail ?? "eval@example.com",
  };
}

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
  const operator = operatorFromContext(context);
  return buildPersonalAgentSystemPrompt(
    PERSONAL_AGENT_NAME,
    PERSONAL_AGENT_PROMPT_FORMAT,
    {
      ...(operator !== undefined ? { operator } : {}),
      ...(context.memberInstructions !== undefined
        ? { instructions: { global: context.memberInstructions } }
        : {}),
      ...(context.model !== undefined ? { model: context.model } : {}),
    },
  );
};

/**
 * v2 compose path (CL-4121 prompt revision, CL-4138 eval parameterization):
 * the exact provider-formatted v2 personal-agent system prompt. `model` is
 * required by v2 — cases that do not set `context.model` fall back to
 * `EVAL_DEFAULT_MODEL` so every case remains composable under both
 * generations.
 */
export const composePersonalAgentEvalPromptV2: ComposeEvalPrompt = ({
  caseDef,
}) => {
  const context = caseDef.context ?? {};
  const operator = operatorFromContext(context);
  return buildPersonalAgentSystemPromptV2(
    PERSONAL_AGENT_NAME,
    PERSONAL_AGENT_PROMPT_FORMAT,
    {
      ...(operator !== undefined ? { operator } : {}),
      ...(context.memberInstructions !== undefined
        ? { instructions: { global: context.memberInstructions } }
        : {}),
      model: context.model ?? EVAL_DEFAULT_MODEL,
    },
  );
};

/**
 * Compose paths keyed by prompt generation, so the runner can drive the same
 * case corpus against every generation in `MYRA_PROMPT_GENERATIONS`.
 */
export const EVAL_COMPOSE_BY_GENERATION: Record<
  MyraPromptGeneration,
  ComposeEvalPrompt
> = {
  v1: composePersonalAgentEvalPrompt,
  v2: composePersonalAgentEvalPromptV2,
};

export {
  PERSONAL_AGENT_PROMPT_VERSION,
  PERSONAL_AGENT_PROMPT_VERSION_V2,
  type MyraPromptGeneration,
};
