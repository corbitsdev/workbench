// Personal agent
export { buildPersonalAgentSystemPrompt } from './personal-agent/prompt';
export {
  buildPersonalAgentGrantRequirements,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
} from './personal-agent/definition';
export { createPersonalAgentDirector } from './personal-agent/director';

// Granola agent
export { buildGranolaSystemPrompt } from './granola/prompt';
export {
  GRANOLA_GRANT_REQUIREMENTS,
  GRANOLA_CREDENTIAL_REQUIREMENTS,
  GRANOLA_DEPLOY_PROMPT,
} from './granola/definition';
export { createGranolaDirector } from './granola/director';

// Shared adapter
export { convertInstanceEvents } from './adapter';

// Prompt builder
export {
  formatFromModel,
  formatSection,
  buildSystemPrompt,
  buildContextBlock,
} from './prompt-builder';
export type { PromptSection, PromptFormat } from './prompt-builder';
