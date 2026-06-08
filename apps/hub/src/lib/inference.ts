import { createAgent, createDefaultDirectorRegistry, defineAgent } from '@intx/agent';
import { noopAuditStore, permissiveAuthorize } from '@intx/agent/testing';
import { createIsogitStore } from '@intx/storage-isogit';
import type { InferenceSource } from '@intx/types/runtime';
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
  // Apply the caller's output-token cap when provided. This is a cap, not a
  // floor: reasoning models can otherwise spend the entire budget on think
  // blocks and truncate the answer, so the cap is tuned per step/agent.
  const effectiveSource: InferenceSource =
    maxOutputTokens !== undefined
      ? { ...source, defaults: { ...source.defaults, maxTokens: maxOutputTokens } }
      : source;

  const definition = defineAgent({
    id: '@workbench/hub/single-turn',
    systemPrompt,
    tools: [],
    capabilities: [],
    inference: { sources: [{ provider: effectiveSource.provider, model: effectiveSource.model }] },
  });

  const storage = await createIsogitStore(contextDir);
  const agent = await createAgent(definition, {
    source: effectiveSource,
    storage,
    workdir: contextDir,
    audit: noopAuditStore(),
    authorize: permissiveAuthorize(),
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  });
  try {
    const result = await agent.send(userMessage);
    return result.reply;
  } finally {
    await agent.close();
  }
}
