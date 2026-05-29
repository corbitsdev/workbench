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

  const systemPrompt = feedback
    ? `You are a sales transcript analyst. Extract up to 5 distinct pain points from the transcript. The user provided this feedback to refine the analysis: "${feedback}". Prioritize pain points that match this feedback. Return exact customer quotes. Respond in JSON format with a "painPoints" array. Each item must have: severity (low, medium, high, or critical), context (a concise summary), and quote (the exact customer words).`
    : `You are a sales transcript analyst. Extract up to 5 distinct pain points from the transcript. Return exact customer quotes. Respond in JSON format with a "painPoints" array. Each item must have: severity (low, medium, high, or critical), context (a concise summary), and quote (the exact customer words).`;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Transcript:\n\n${content.slice(0, 100000)}` },
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

export function extractPainPointsFallback(
  workflowId: string,
  content: string
): ExtractedPainPoint[] {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const points: ExtractedPainPoint[] = [];

  const painKeywords: { keyword: string; severity: 'low' | 'medium' | 'high' | 'critical' }[] = [
    { keyword: 'difficult', severity: 'high' },
    { keyword: 'frustrat', severity: 'high' },
    { keyword: 'pain', severity: 'high' },
    { keyword: 'problem', severity: 'medium' },
    { keyword: 'challenge', severity: 'medium' },
    { keyword: 'slow', severity: 'medium' },
    { keyword: 'manual', severity: 'medium' },
    { keyword: 'generic', severity: 'high' },
    { keyword: 'waste', severity: 'high' },
    { keyword: 'never', severity: 'high' },
    { keyword: 'always', severity: 'high' },
    { keyword: 'every', severity: 'high' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.toLowerCase();
    for (const { keyword, severity } of painKeywords) {
      if (line.includes(keyword)) {
        const context = raw.trim();
        const quote = raw.trim();
        if (context.length > 10) {
          points.push({
            sessionId: workflowId,
            severity,
            context,
            quote,
            selected: true,
          });
        }
        break;
      }
    }
  }

  const seen = new Set<string>();
  const deduped = points.filter((p) => {
    const key = p.context.slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, 5);
}

export async function extractPainPoints(
  workflowId: string,
  content: string,
  feedback?: string
): Promise<ExtractedPainPoint[]> {
  const llmPoints = await extractPainPointsWithLLM(workflowId, content, feedback);
  if (llmPoints.length > 0) {
    return llmPoints;
  }
  return extractPainPointsFallback(workflowId, content);
}
