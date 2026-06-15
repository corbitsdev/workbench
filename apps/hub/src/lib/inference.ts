import { createAgent, defineAgent, createDefaultDirectorRegistry } from '@intx/agent';
import type { InferenceSource } from '@intx/types/runtime';
import { createIsogitStore } from '@intx/storage-isogit';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

// A workflow inference call must be bounded. Without this, a slow or hung
// provider leaves `agent.send` pending forever, which wedges the whole workflow
// step (analyze/generate) and pins the run in an in-progress status with no
// recovery (CL-1922). The bound is generous — it catches true hangs, not
// slow-but-working reasoning calls.
const DEFAULT_INFERENCE_TIMEOUT_MS = 180_000;

export async function runSingleTurnAgent(
  source: InferenceSource,
  systemPrompt: string,
  userMessage: string,
  contextPrefix: string,
  maxOutputTokens?: number,
  timeoutMs: number = DEFAULT_INFERENCE_TIMEOUT_MS
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
    authorize: async () => ({ effect: 'allow' as const, matchingGrants: [], resolvedBy: null }),
    directors: createDefaultDirectorRegistry(),
    closeTimeoutMs: 1000,
  };

  const agent = await createAgent(def, env);

  async function drainStream() {
    for await (const _ of agent.stream()) {
    }
  }

  const drainDone = drainStream();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      agent.send(userMessage),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Inference timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return result.reply;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await agent.close();
    await drainDone.catch(() => {});
    // Reclaim the per-call context dir. Without this, every call (and now every
    // timed-out call) leaves an orphaned tmp store behind (CL-1922).
    await rm(contextDir, { recursive: true, force: true }).catch(() => {});
  }
}
