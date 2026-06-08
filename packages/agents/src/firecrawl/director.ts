import { createDefaultDirector } from '@intx/inference';
import type { ReactorDirector, ToolDefinition } from '@intx/types/runtime';

export function createFirecrawlDirector(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[]
): ReactorDirector {
  return createDefaultDirector(systemPrompt, toolDefinitions);
}
