import type { MyraPersona } from "./persona";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
} from "../core/definition";

/**
 * The thread persona is Myra's chat behavior — the Chief-of-Staff posture a
 * user talks to in an interactive chat thread. Its prompt and tool loadout are
 * the current shipped Myra (`PERSONAL_AGENT_DEPLOY_PROMPT` and
 * `PERSONAL_AGENT_BASE_TOOLS`); this persona is entered via the existing
 * myra-threads path, so extracting it changes no runtime behavior.
 */
export const threadPersona: MyraPersona = {
  key: "thread",
  description:
    "Myra's chat persona: Chief of Staff over the full company context, mounted on an interactive chat thread.",
  systemPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
  toolNames: PERSONAL_AGENT_BASE_TOOLS,
};
