import { createAgent } from '@intx/agent';
import type { InferenceSource } from '@intx/types/runtime';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
