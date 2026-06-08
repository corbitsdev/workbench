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

export async function generateCollateralWithLLM(
  workflowId: string,
  transcript: string,
  point: PainPointInput,
  type: string,
  source: InferenceSource,
  maxOutputTokens?: number
): Promise<GeneratedCollateral> {
  log.info('Generating collateral', { workflowId, painPointId: point.id, type });

  const userMessage = `Transcript (for context):\n\n${transcript.slice(0, 60000)}\n\n---\n\nPain point to address:\n- Summary: ${point.context}\n- Severity: ${point.severity}\n- Verbatim quote: "${point.quote}"\n\nGenerate the ${type} collateral now.`;

  const raw = await runSingleTurnAgent(
    source,
    buildCollateralSystemPrompt(type),
    userMessage,
    'gtm-generation',
    maxOutputTokens
  );

  if (!raw) throw new Error('LLM returned empty content for collateral generation');

  let parsed: { title?: string; body?: string };
  try {
    parsed = JSON.parse(raw) as { title?: string; body?: string };
  } catch {
    log.error('Collateral generation returned invalid JSON', {
      workflowId,
      type,
      raw: raw.slice(0, 500),
    });
    throw new Error('LLM returned invalid JSON for collateral generation');
  }
  if (!parsed.title || !parsed.body) {
    log.error('Collateral generation missing title or body', {
      workflowId,
      type,
      raw: raw.slice(0, 500),
    });
    throw new Error('LLM response missing title or body');
  }

  log.info('Collateral generated', { workflowId, painPointId: point.id, type });

  return { title: parsed.title.slice(0, 500), body: parsed.body.slice(0, 10000) };
}
