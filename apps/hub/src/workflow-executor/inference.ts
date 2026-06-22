import { createAgent, createDefaultDirectorRegistry, defineAgent } from '@intx/agent';
import { createIsogitStore } from '@intx/storage-isogit';
import type { InferenceSource } from '@intx/types/runtime';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Single-turn, tool-less inference for a reasoning step. Ported from the
// pre-substrate fast path (`apps/hub/src/lib/inference.ts` @ b3cad9e8): an
// ephemeral isogit context in tmpdir, an allow-all authorizer, one
// `agent.send`, then close. No tool loop, no persistent context to replay —
// exactly the cost the thin executor is restoring.
export async function runReasoningStep(args: {
  source: InferenceSource;
  systemPrompt: string;
  userMessage: string;
  maxOutputTokens?: number;
}): Promise<string> {
  const contextDir = join(tmpdir(), `wf-step-${randomUUID()}`);
  const effectiveSource: InferenceSource =
    args.maxOutputTokens !== undefined
      ? { ...args.source, defaults: { ...args.source.defaults, maxTokens: args.maxOutputTokens } }
      : args.source;

  const store = await createIsogitStore(contextDir);

  const def = defineAgent({
    id: `wf-step-${randomUUID()}`,
    systemPrompt: args.systemPrompt,
    tools: [],
    capabilities: [],
    inference: {
      sources: [{ provider: effectiveSource.provider, model: effectiveSource.model }],
    },
  });

  const env = {
    sources: [effectiveSource],
    defaultSource: effectiveSource.id,
    storage: store,
    workdir: contextDir,
    audit: store,
    authorize: async () => ({ effect: 'allow' as const, matchingGrants: [], resolvedBy: null }),
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  };

  const agent = await createAgent(def, env);

  async function drainStream(): Promise<void> {
    for await (const _event of agent.stream()) {
      // Draining the stream is required for `send` to resolve.
    }
  }

  const drainDone = drainStream();
  try {
    const result = await agent.send(args.userMessage);
    return result.reply;
  } finally {
    await agent.close();
    await drainDone.catch(() => undefined);
  }
}
