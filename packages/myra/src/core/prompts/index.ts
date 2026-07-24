import {
  buildPersonalAgentSystemPrompt,
  PERSONAL_AGENT_PROMPT_VERSION,
} from "./v1";
import {
  buildPersonalAgentSystemPromptV2,
  PERSONAL_AGENT_PROMPT_VERSION_V2,
} from "./v2";

export * from "./v1";
export * from "./v2";

/**
 * The selectable prompt generations. A variant (the user-facing selection
 * unit) binds to exactly one entry; v1 stays the default and byte-identical
 * to the pre-split prompt. Tool-catalog pinning per generation lands with
 * the package-registry work (see the CL-4121 doc, delivery plan PR 3).
 */
export const MYRA_PROMPT_GENERATIONS = {
  v1: {
    promptVersion: PERSONAL_AGENT_PROMPT_VERSION,
    build: buildPersonalAgentSystemPrompt,
  },
  v2: {
    promptVersion: PERSONAL_AGENT_PROMPT_VERSION_V2,
    build: buildPersonalAgentSystemPromptV2,
  },
} as const;

export type MyraPromptGeneration = keyof typeof MYRA_PROMPT_GENERATIONS;
