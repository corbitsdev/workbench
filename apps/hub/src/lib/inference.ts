import { createAgent, defineAgent, createDefaultDirectorRegistry } from '@intx/agent';
import {
  createDefaultDependencies,
  createGoogleGenAIAdapter,
  registerProvider,
  runInference,
  type ProviderAdapter,
} from '@intx/inference';
import type {
  ConversationTurn,
  ImageBlock,
  InferenceOptions,
  InferenceSource,
} from '@intx/types/runtime';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stripGeminiThoughtSignatures(sseData: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sseData);
  } catch {
    return sseData;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) return sseData;
  for (const candidate of parsed.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (isRecord(part)) delete part.thoughtSignature;
    }
  }
  return JSON.stringify(parsed);
}

let geminiPatchInstalled = false;

function installGeminiThoughtSignaturePatch(): void {
  if (geminiPatchInstalled) return;
  geminiPatchInstalled = true;
  registerProvider('google-genai', (source): ProviderAdapter => {
    const inner = createGoogleGenAIAdapter(source);
    return {
      ...inner,
      parseResponse: (sseData) => inner.parseResponse(stripGeminiThoughtSignatures(sseData)),
    };
  });
}

// DELIBERATE DEVIATION FROM CL-1971's "extend runSingleTurnAgent" framing:
// Interchange's agent `send` path CANNOT carry an image — it builds a text-only
// turn and ignores attachments (confirmed in @intx/agent and documented by the
// TKWW pilot's generate.ts). So the image variant bypasses the agent and calls
// `runInference` directly with a multimodal user turn (text + base64 ImageBlock).
// There is therefore no ephemeral agent, isogit store, or context dir to clean
// up here; the bound is enforced with an AbortSignal instead of Promise.race.
export async function runSingleTurnAgentWithImage(
  source: InferenceSource,
  systemPrompt: string,
  userMessage: string,
  image: ImageBlock,
  maxOutputTokens?: number,
  timeoutMs: number = DEFAULT_INFERENCE_TIMEOUT_MS
): Promise<string> {
  if (source.provider === 'google-genai') installGeminiThoughtSignaturePatch();

  const turns: ConversationTurn[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: userMessage }, image],
      timestamp: 0,
    },
  ];

  const inferenceOptions: InferenceOptions = {
    systemPrompt,
    ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let seq = 0;
  let text = '';
  let refused = false;
  try {
    for await (const event of runInference({
      turns,
      source,
      nextSeq: () => seq++,
      deps: createDefaultDependencies(),
      inferenceOptions,
      signal: controller.signal,
    })) {
      const typed = event as { type: string; data?: unknown };
      if (typed.type === 'inference.refusal.delta') {
        refused = true;
      } else if (typed.type === 'inference.done') {
        const turn = (typed.data as { turn?: { content?: Array<{ type: string; text?: string }> } })
          ?.turn;
        for (const block of turn?.content ?? []) {
          if (block.type === 'text' && typeof block.text === 'string') text += block.text;
        }
      } else if (typed.type === 'inference.error') {
        throw new Error(`Inference error: ${JSON.stringify(typed.data)}`);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Inference timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (refused) throw new Error('Model refused the request');
  if (text.trim() === '') throw new Error('Inference produced no text');
  return text;
}

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
