import { createAgent } from '@intx/agent';
import type { InferenceSource } from '@intx/types/runtime';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig } from '../config';

export function buildInferenceSource(prefix: string): InferenceSource {
  const { llm } = getConfig();
  return {
    id: `${prefix}-${randomUUID()}`,
    provider: 'openai', // all configured endpoints use OpenAI wire format (OPENAI_COMPATIBLE_*)
    baseURL: llm.baseUrl ?? 'https://api.openai.com/v1',
    apiKey: llm.apiKey,
    model: llm.model,
  };
}

export async function runSingleTurnAgent(
  source: InferenceSource,
  systemPrompt: string,
  userMessage: string,
  contextPrefix: string
): Promise<string> {
  const contextDir = join(tmpdir(), `${contextPrefix}-${randomUUID()}`);
  const agent = await createAgent({
    contextDir,
    sources: [source],
    defaultSource: source.id,
    systemPrompt,
    tools: [],
    closeTimeoutMs: 1000,
  });
  try {
    const result = await agent.send(userMessage);
    return result.reply;
  } finally {
    await agent.close();
  }
}
