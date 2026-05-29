import { getLogger } from '@intx/log';

const log = getLogger(['api', 'extraction']);

export interface ExtractedPainPoint {
  sessionId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  context: string;
  quote: string;
  selected: boolean;
}

interface LLMResponse {
  painPoints: Array<{
    severity: 'low' | 'medium' | 'high' | 'critical';
    context: string;
    quote: string;
  }>;
}

export async function extractPainPointsWithLLM(
  workflowId: string,
  content: string,
  feedback: string | undefined
): Promise<ExtractedPainPoint[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

  if (!apiKey) {
    return [];
  }

  const systemPrompt = `You are a sales transcript analyst. Extract up to 5 distinct pain points from the transcript. Return exact customer quotes. Respond in JSON format with a "painPoints" array. Each item must have: severity (low, medium, high, or critical), context (a concise summary), and quote (the exact customer words).`;

  const userMessage = feedback
    ? `Transcript:\n\n${content.slice(0, 100000)}\n\n---\n\nRefinement direction from user: ${feedback}`
    : `Transcript:\n\n${content.slice(0, 100000)}`;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 2048,
  };

  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      log.warn('LLM extraction failed', { status: res.status, error: err.error });
      return [];
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = data.choices[0]?.message?.content;
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as LLMResponse;
    if (!Array.isArray(parsed.painPoints)) {
      return [];
    }

    return parsed.painPoints.map((p) => ({
      sessionId: workflowId,
      severity: ['low', 'medium', 'high', 'critical'].includes(p.severity) ? p.severity : 'medium',
      context: p.context.slice(0, 500),
      quote: p.quote.slice(0, 500),
      selected: true,
    }));
  } catch (err) {
    log.warn('LLM extraction threw', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function extractPainPoints(
  workflowId: string,
  content: string,
  feedback?: string
): Promise<ExtractedPainPoint[]> {
  return extractPainPointsWithLLM(workflowId, content, feedback);
}
