import type { InferenceSource } from '@intx/types/runtime';
import { createAgent } from '@intx/agent';
import { getLogger } from '@intx/log';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const log = getLogger(['extraction']);

export interface ExtractedPainPoint {
  sessionId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  context: string;
  quote: string;
  selected: boolean;
}

interface LLMResponse {
  companyName?: string | null;
  painPoints: Array<{
    severity: 'low' | 'medium' | 'high' | 'critical';
    context: string;
    quote: string;
  }>;
}

export interface ExtractionResult {
  painPoints: ExtractedPainPoint[];
  companyName: string | null;
}

export async function extractPainPointsWithLLM(
  workflowId: string,
  content: string,
  feedback: string | undefined
): Promise<ExtractionResult> {
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1';

  log.info('Starting LLM extraction', { workflowId, transcriptLength: content.length, model });

  if (!apiKey) {
    log.error('Missing OPENAI_COMPATIBLE_API_KEY');
    throw new Error('OPENAI_COMPATIBLE_API_KEY is required for pain point extraction');
  }

  const source: InferenceSource = {
    id: `extraction-${workflowId}`,
    provider: 'openai',
    baseURL,
    apiKey,
    model,
  };

  const systemPrompt = `You are a sales transcript analyst. Extract up to 5 distinct pain points from the transcript. Also try to identify the prospect company name if mentioned. Respond in JSON format with: "companyName" (string or null if unknown), and "painPoints" array where each item has: severity (low, medium, high, or critical), context (a concise summary), and quote (the exact customer words).`;

  const userMessage = feedback
    ? `Transcript:\n\n${content.slice(0, 100000)}\n\n---\n\nRefinement direction from user: ${feedback}`
    : `Transcript:\n\n${content.slice(0, 100000)}`;

  try {
    const contextDir = join(tmpdir(), `gtm-extraction-${randomUUID()}`);

    const agent = await createAgent({
      contextDir,
      sources: [source],
      defaultSource: source.id,
      systemPrompt,
      tools: [],
      closeTimeoutMs: 1000,
    });

    const result = await agent.send(userMessage);
    await agent.close();

    log.info('LLM response received', { length: result.reply.length });

    let parsed: LLMResponse;
    try {
      parsed = JSON.parse(result.reply) as LLMResponse;
    } catch {
      log.error('LLM extraction returned invalid JSON', { workflowId, raw: result.reply });
      throw new Error('LLM returned invalid JSON for pain point extraction');
    }

    if (!Array.isArray(parsed.painPoints)) {
      log.error('LLM response missing painPoints array', { raw: result.reply });
      throw new Error('LLM response missing painPoints array');
    }

    const companyName =
      typeof parsed.companyName === 'string' && parsed.companyName.trim()
        ? parsed.companyName.trim().slice(0, 200)
        : null;

    log.info('Pain points extracted', { count: parsed.painPoints.length, companyName });

    return {
      companyName,
      painPoints: parsed.painPoints.map((p) => {
        const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
        const validSeverity = VALID_SEVERITIES.includes(p.severity as (typeof VALID_SEVERITIES)[number])
          ? (p.severity as (typeof VALID_SEVERITIES)[number])
          : null;
        if (!validSeverity) {
          log.warn('Unknown severity from LLM, defaulting to medium', { workflowId, raw: p.severity });
        }
        return {
          sessionId: workflowId,
          severity: validSeverity ?? 'medium',
          context: p.context.slice(0, 500),
          quote: p.quote.slice(0, 500),
          selected: true,
        };
      }),
    };
  } catch (err) {
    log.error('LLM extraction failed', { error: err instanceof Error ? err.message : String(err) });
    throw new Error(`LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function extractPainPoints(
  workflowId: string,
  content: string,
  feedback?: string
): Promise<ExtractionResult> {
  return extractPainPointsWithLLM(workflowId, content, feedback);
}
