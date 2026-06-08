// Personal agent
export { buildPersonalAgentSystemPrompt } from './personal-agent/prompt';
export {
  buildPersonalAgentGrantRequirements,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
} from './personal-agent/definition';
export { createPersonalAgentDirector } from './personal-agent/director';

// Loop agent
export { buildLoopAgentSystemPrompt } from './loop/prompt';
export { LOOP_CREDENTIAL_REQUIREMENTS, LOOP_DEPLOY_PROMPT } from './loop/definition';

// Granola agent
export { buildGranolaSystemPrompt } from './granola/prompt';
export {
  GRANOLA_GRANT_REQUIREMENTS,
  GRANOLA_CREDENTIAL_REQUIREMENTS,
  GRANOLA_DEPLOY_PROMPT,
} from './granola/definition';
export { createGranolaDirector } from './granola/director';

// Firecrawl agent
export { buildFirecrawlSystemPrompt } from './firecrawl/prompt';
export {
  FIRECRAWL_GRANT_REQUIREMENTS,
  FIRECRAWL_CREDENTIAL_REQUIREMENTS,
  FIRECRAWL_DEPLOY_PROMPT,
} from './firecrawl/definition';
export { createFirecrawlDirector } from './firecrawl/director';

// Shared adapter
export { convertInstanceEvents } from './adapter';
export { createToolNameTracker, type ToolNameTracker } from './tool-name-tracker';
export {
  composeChatMessages,
  type ComposeChatInput,
  type ComposeChatResult,
} from './chat-messages';

// Prompt builder
export { formatSection, buildSystemPrompt, buildContextBlock } from './prompt-builder';
export type { PromptSection, PromptFormat } from './prompt-builder';
