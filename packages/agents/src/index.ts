// Shared constants
export { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from './constants';

// Personal agent
export { buildPersonalAgentSystemPrompt } from './personal-agent/prompt';
export {
  buildPersonalAgentGrantRequirements,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
} from './personal-agent/definition';
export { createPersonalAgentDirector } from './personal-agent/director';
export {
  PERSONAL_AGENT_SEED_FILES,
  buildSeedMarker,
  parseSeedMarker,
  type SeedWorkspaceFile,
} from './personal-agent/seed-files';

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

// Walter agent
export { buildWalterSystemPrompt } from './walter/prompt';
export {
  WALTER_GRANT_REQUIREMENTS,
  WALTER_CREDENTIAL_REQUIREMENTS,
  WALTER_DEPLOY_PROMPT,
} from './walter/definition';

// Bobby — the browser
export { buildBobbySystemPrompt } from './bobby/prompt';
export {
  BOBBY_GRANT_REQUIREMENTS,
  BOBBY_CREDENTIAL_REQUIREMENTS,
  BOBBY_DEPLOY_PROMPT,
  BOBBY_CAPABILITIES,
  BOBBY_DEPLOY_DESCRIPTOR,
} from './bobby/definition';

// Lincoln agent
export { buildLincolnSystemPrompt } from './lincoln/prompt';
export {
  LINCOLN_GRANT_REQUIREMENTS,
  LINCOLN_CREDENTIAL_REQUIREMENTS,
  LINCOLN_DEPLOY_PROMPT,
  LINCOLN_CAPABILITIES,
  LINCOLN_DEPLOY_DESCRIPTOR,
} from './lincoln/definition';

// Hammy — the humanizer
export { buildHammySystemPrompt } from './hammy-the-humanizer/prompt';
export {
  HAMMY_GRANT_REQUIREMENTS,
  HAMMY_CREDENTIAL_REQUIREMENTS,
  HAMMY_DEPLOY_PROMPT,
  HAMMY_CAPABILITIES,
} from './hammy-the-humanizer/definition';

// Larry — last30days research
export { buildLarrySystemPrompt } from './larry/prompt';
export { LARRY_SKILL_CONTENT } from './larry/skill';
export {
  LARRY_GRANT_REQUIREMENTS,
  LARRY_CREDENTIAL_REQUIREMENTS,
  LARRY_DEPLOY_PROMPT,
  LARRY_CAPABILITIES,
  LARRY_DEPLOY_DESCRIPTOR,
} from './larry/definition';

// Skills registry
export {
  SKILLS_REGISTRY,
  getSkillById,
  listSkills,
  type SkillEntry,
} from './skills-registry';

// Agent templates registry
export { AGENT_TEMPLATES, type AgentTemplate } from './templates';

// Shared adapter
export { convertInstanceEvents } from './adapter';
export { createToolNameTracker, type ToolNameTracker } from './tool-name-tracker';
export { createLiveTextTracker, type LiveTextTracker } from './live-text-tracker';
export { createReasoningTracker, type ReasoningTracker } from './reasoning-tracker';
export { createImageTracker, type ImageTracker, type CapturedImage } from './image-tracker';
export { deriveAgentPhase, type AgentPhase } from './agent-phase';
export {
  composeChatMessages,
  STREAMING_BUBBLE_ID,
  type ComposeChatInput,
  type ComposeChatResult,
} from './chat-messages';

// Prompt builder
export {
  formatSection,
  buildSystemPrompt,
  buildContextBlock,
  HUMANIZER_SECTION,
} from './prompt-builder';
export type { PromptSection, PromptFormat } from './prompt-builder';

export {
  FREDDIE_DEPLOY_PROMPT,
  FREDDIE_GRANT_REQUIREMENTS,
  FREDDIE_CREDENTIAL_REQUIREMENTS,
  FREDDIE_CAPABILITIES,
  FREDDIE_MODEL_CONFIG,
  FREDDIE_DEPLOY_DESCRIPTOR,
} from './freddie/definition';

export {
  FANNIE_DEPLOY_PROMPT,
  FANNIE_GRANT_REQUIREMENTS,
  FANNIE_CREDENTIAL_REQUIREMENTS,
  FANNIE_CAPABILITIES,
  FANNIE_MODEL_CONFIG,
  FANNIE_DEPLOY_DESCRIPTOR,
} from './fannie/definition';
