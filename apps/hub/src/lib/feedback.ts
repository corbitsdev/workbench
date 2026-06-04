import { createAgent } from '@intx/agent';
import { getLogger } from '@intx/log';
import type { InferenceSource } from '@intx/types/runtime';
import type { ArtifactKind } from '@workbench/shared';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = getLogger(['feedback']);

function buildFeedbackSystemPrompt(type: ArtifactKind): string {
  switch (type) {
    case 'linkedin':
      return `You are a sales copywriter editing a LinkedIn post. Apply the user's feedback strictly. Critical rules: never mention client names, company names, prospect names, or any identifying details — generalise to a category or job function. The insight must feel universal. Return only the refined text, no explanations.`;
    case 'email':
      return `You are a senior outbound sales rep editing a follow-up email. Apply the user's feedback. Keep the email sounding human — not a template. Vary sentence length, strip hollow adjectives, and make every word earn its place. Return only the refined text, no explanations.`;
    case 'one-pager':
      return `You are a sales copywriter editing a one-pager. Apply the user's feedback. Keep every section grounded in the prospect's specific numbers, team size, and language. Return only the refined text, no explanations.`;
    case 'battlecard':
      return `You are a sales copywriter editing paid ad copy. Apply the user's feedback. Keep each variant distinct in angle, headlines specific (use numbers or language from the context), and CTAs active and concrete. Return only the refined text, no explanations.`;
  }
}

export async function refineFeedbackWithLLM(
  text: string,
  feedback: string,
  type: ArtifactKind = 'email'
): Promise<string> {
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1';

  if (!apiKey) {
    throw new Error('LLM feedback refinement requires OPENAI_COMPATIBLE_API_KEY');
  }

  log.info('Refining collateral with feedback', { type });

  const source: InferenceSource = {
    id: `feedback-${randomUUID()}`,
    provider: 'openai',
    baseURL,
    apiKey,
    model,
  };

  const userMessage = `Original text:\n\n${text}\n\nFeedback to apply:\n${feedback}\n\nRefined text:`;

  const contextDir = join(tmpdir(), `gtm-feedback-${randomUUID()}`);
  const agent = await createAgent({
    contextDir,
    sources: [source],
    defaultSource: source.id,
    systemPrompt: buildFeedbackSystemPrompt(type),
    tools: [],
    closeTimeoutMs: 1000,
  });

  let raw: string;
  try {
    const result = await agent.send(userMessage);
    raw = result.reply;
  } finally {
    await agent.close();
  }

  const refined = raw?.trim();
  if (!refined || refined.length === 0) {
    throw new Error('LLM returned empty response for feedback refinement');
  }

  log.info('Collateral refined with feedback', { type });

  return refined;
}
