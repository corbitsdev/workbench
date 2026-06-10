import { getLogger } from '@intx/log';
import type { InferenceSource } from '@intx/types/runtime';
import type { ArtifactKind } from '@workbench/shared';
import { runSingleTurnAgent } from './inference';

const log = getLogger(['feedback']);

function buildFeedbackSystemPrompt(type: ArtifactKind): string {
  switch (type) {
    case 'linkedin-post':
    case 'twitter-post':
    case 'founder-pov-post':
      return `You are a sales copywriter editing a social post. Apply the user's feedback strictly. Critical rules: never mention client names, company names, prospect names, or any identifying details — generalise to a category or job function. The insight must feel universal. Return only the refined text, no explanations.`;
    case 'email':
      return `You are a senior outbound sales rep editing a follow-up email. Apply the user's feedback. Keep the email sounding human — not a template. Vary sentence length, strip hollow adjectives, and make every word earn its place. Return only the refined text, no explanations.`;
    case 'one-pager':
    case 'blog':
    case 'case-study':
    case 'objection-handling':
    case 'customer-quotes':
      return `You are a sales copywriter editing a GTM document. Apply the user's feedback. Keep every section grounded in the prospect's specific numbers, team size, and language. Return only the refined text, no explanations.`;
    case 'battlecard':
      return `You are a sales copywriter editing paid ad copy. Apply the user's feedback. Keep each variant distinct in angle, headlines specific (use numbers or language from the context), and CTAs active and concrete. Return only the refined text, no explanations.`;
    case 'pain-points':
    case 'call-transcript':
      return `You are editing a structured document. Apply the user's feedback carefully. Preserve the original format and structure. Return only the refined text, no explanations.`;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown artifact kind: ${String(_exhaustive)}`);
    }
  }
}

export async function refineFeedbackWithLLM(
  text: string,
  feedback: string,
  type: ArtifactKind = 'email',
  source: InferenceSource,
  maxOutputTokens?: number
): Promise<string> {
  log.info('Refining collateral with feedback', { type });

  const userMessage = `Original text:\n\n${text}\n\nFeedback to apply:\n${feedback}\n\nRefined text:`;

  const raw = await runSingleTurnAgent(
    source,
    buildFeedbackSystemPrompt(type),
    userMessage,
    'gtm-feedback',
    maxOutputTokens
  );
  const refined = raw?.trim() ?? '';
  if (!refined || refined.length === 0) {
    throw new Error('LLM returned empty response for feedback refinement');
  }

  log.info('Collateral refined with feedback', { type });

  return refined;
}
