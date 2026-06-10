import { getLogger } from '@intx/log';
import type { InferenceSource } from '@intx/types/runtime';
import {
  buildCollateralRulesBlock,
  buildCollateralSystemPrompt,
  isPublicCollateralKind,
} from '@workbench/gtm-workflows/collateral-generation';
import { runSingleTurnAgent } from './inference';

const log = getLogger(['generation']);

interface PainPointInput {
  id: string;
  context: string;
  quote: string;
  severity: string;
}

interface GeneratedCollateral {
  title: string;
  body: string;
}

export const buildRulesBlock = buildCollateralRulesBlock;
export const isPublicKind = isPublicCollateralKind;

// Long-form types produce significantly more content and hit the 8192-token
// ceiling when run at the default limit. Use a higher ceiling for these kinds.
const LONG_FORM_KINDS = new Set([
  'blog',
  'case-study',
  'founder-pov-post',
  'objection-handling',
  'customer-quotes',
  'one-pager',
]);
const LONG_FORM_MAX_TOKENS = 16384;

function tryParseCollateral(
  raw: string,
  workflowId: string,
  type: string
): { title: string; body: string } {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  let parsed: { title?: string; body?: string };
  try {
    parsed = JSON.parse(stripped) as { title?: string; body?: string };
  } catch (parseErr) {
    log.error('Collateral generation returned invalid JSON', {
      workflowId,
      type,
      parseError: String(parseErr),
      rawTail: raw.slice(-200),
    });
    throw new Error(`LLM returned invalid JSON for ${type} collateral`);
  }
  if (!parsed.title || !parsed.body) {
    log.error('Collateral generation missing title or body', {
      workflowId,
      type,
      raw: raw.slice(0, 500),
    });
    throw new Error(`LLM response missing title or body for ${type}`);
  }
  return {
    title: parsed.title.slice(0, 500),
    body: parsed.body.slice(0, 10000),
  };
}

export async function generateCollateralWithLLM(
  workflowId: string,
  transcript: string,
  point: PainPointInput,
  type: string,
  source: InferenceSource,
  maxOutputTokens?: number
): Promise<GeneratedCollateral> {
  log.info('Generating collateral', {
    workflowId,
    painPointId: point.id,
    type,
  });

  const resolvedMaxTokens =
    maxOutputTokens ?? (LONG_FORM_KINDS.has(type) ? LONG_FORM_MAX_TOKENS : undefined);

  const userMessage = `Transcript (for context):\n\n${transcript.slice(0, 60000)}\n\n---\n\nPain point to address:\n- Summary: ${point.context}\n- Severity: ${point.severity}\n- Verbatim quote: "${point.quote}"\n\nGenerate the ${type} collateral now.`;

  const raw = await runSingleTurnAgent(
    source,
    buildCollateralSystemPrompt(type),
    userMessage,
    'gtm-generation',
    resolvedMaxTokens
  );

  if (!raw) throw new Error('LLM returned empty content for collateral generation');

  try {
    const result = tryParseCollateral(raw, workflowId, type);
    log.info('Collateral generated', {
      workflowId,
      painPointId: point.id,
      type,
    });
    return result;
  } catch {
    // Retry once. Long-form kinds get a JSON-only instruction (they need the
    // content length); short-form kinds get a brevity cap to avoid truncation.
    log.warn('Retrying collateral generation', { workflowId, type });
    const retryHint = LONG_FORM_KINDS.has(type)
      ? 'IMPORTANT: Your previous response was not valid JSON. Return only a JSON object with "title" and "body" keys — no markdown fences, no extra text.'
      : 'IMPORTANT: Keep the body concise — 400 words or fewer. Return valid JSON only.';
    const retryMessage = `${userMessage}\n\n${retryHint}`;
    const retryRaw = await runSingleTurnAgent(
      source,
      buildCollateralSystemPrompt(type),
      retryMessage,
      'gtm-generation',
      resolvedMaxTokens
    );
    if (!retryRaw) throw new Error('LLM returned empty content on retry for collateral generation');
    const result = tryParseCollateral(retryRaw, workflowId, type);
    log.info('Collateral generated (retry)', {
      workflowId,
      painPointId: point.id,
      type,
    });
    return result;
  }
}
