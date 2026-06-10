import { createAgent, defineAgent, createDefaultDirectorRegistry } from '@intx/agent';
import type { InferenceSource } from '@intx/types/runtime';
import { createIsogitStore } from '@intx/storage-isogit';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function runSingleTurnAgent(
  source: InferenceSource,
  systemPrompt: string,
  userMessage: string,
  contextPrefix: string,
  maxOutputTokens?: number
): Promise<string> {
  const contextDir = join(tmpdir(), `${contextPrefix}-${randomUUID()}`);
  const effectiveSource: InferenceSource =
    maxOutputTokens !== undefined
      ? { ...source, defaults: { ...source.defaults, maxTokens: maxOutputTokens } }
      : source;

  const store = await createIsogitStore(contextDir);

  const def = defineAgent({
    id: `runSingleTurn-${randomUUID()}`,
    systemPrompt,
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: effectiveSource.provider, model: effectiveSource.model }],
    },
  });

  const env = {
    source: effectiveSource,
    storage: store,
    workdir: contextDir,
    audit: store,
    // Permissive because this agent has no tools. If tools are ever added, wire
    // this to a real grant check via authorize() from @intx/authz.
    authorize: async () => ({ effect: 'allow' as const, matchingGrants: [], resolvedBy: null }),
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  };

  const agent = await createAgent(def, env);
  try {
    const result = await agent.send(userMessage);
    return result.reply;
  } finally {
    await agent.close();
  }
}
