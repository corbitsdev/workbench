export { LOOP_DEPLOY_PROMPT, LOOP_DEPLOY_DESCRIPTOR } from './loop/definition';
export {
  GRANOLA_DEPLOY_PROMPT,
  GRANOLA_CAPABILITIES,
  GRANOLA_DEPLOY_DESCRIPTOR,
} from './granola/definition';
export {
  FIRECRAWL_DEPLOY_PROMPT,
  FIRECRAWL_CAPABILITIES,
  FIRECRAWL_DEPLOY_DESCRIPTOR,
} from './firecrawl/definition';
export {
  WALTER_DEPLOY_PROMPT,
  WALTER_CAPABILITIES,
  WALTER_DEPLOY_DESCRIPTOR,
} from './walter/definition';
export { convertInstanceEvents } from './adapter';
export { createToolNameTracker, type ToolNameTracker } from './tool-name-tracker';
export { createLiveTextTracker, type LiveTextTracker } from './live-text-tracker';
export {
  composeChatMessages,
  type ComposeChatInput,
  type ComposeChatResult,
} from './chat-messages';
export { buildContextBlock } from './prompt-builder';
export type { AgentDeployDescriptor } from './deploy-descriptor';

import { LOOP_DEPLOY_DESCRIPTOR } from './loop/definition';
import { GRANOLA_DEPLOY_DESCRIPTOR } from './granola/definition';
import { FIRECRAWL_DEPLOY_DESCRIPTOR } from './firecrawl/definition';
import { WALTER_DEPLOY_DESCRIPTOR } from './walter/definition';
import type { AgentDeployDescriptor } from './deploy-descriptor';

/** All premade agents available for deployment from the UI. */
export const PREMADE_AGENTS: AgentDeployDescriptor[] = [
  LOOP_DEPLOY_DESCRIPTOR,
  GRANOLA_DEPLOY_DESCRIPTOR,
  FIRECRAWL_DEPLOY_DESCRIPTOR,
  WALTER_DEPLOY_DESCRIPTOR,
];
