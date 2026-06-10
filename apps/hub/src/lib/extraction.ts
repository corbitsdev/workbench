import { getLogger } from '@intx/log';
import type { InferenceSource } from '@intx/types/runtime';
import type { GrantStore } from '@intx/types/authz';
import { runSingleTurnAgent } from './inference';

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

interface TranscriptChunk {
  index: number;
  total: number;
  phase: 'opening' | 'middle' | 'final';
  content: string;
}

interface BuildExtractionUserMessageOptions {
  chunk?: TranscriptChunk;
  previousPainPoints?: LLMResponse['painPoints'];
}

const ASSUMED_CONTEXT_WINDOW_TOKENS = 128000;
const RESERVED_OUTPUT_TOKENS = 4096;
const APPROX_CHARS_PER_TOKEN = 4;
const PROMPT_SAFETY_MARGIN_CHARS = 120000;
export const SINGLE_PASS_TRANSCRIPT_CHARS =
  (ASSUMED_CONTEXT_WINDOW_TOKENS - RESERVED_OUTPUT_TOKENS) * APPROX_CHARS_PER_TOKEN -
  PROMPT_SAFETY_MARGIN_CHARS;
const CHUNK_TRANSCRIPT_CHARS = Math.floor(SINGLE_PASS_TRANSCRIPT_CHARS / 2);

export function splitTranscriptForExtraction(
  content: string,
  feedbackOverheadChars = 0
): TranscriptChunk[] {
  const budget = SINGLE_PASS_TRANSCRIPT_CHARS - feedbackOverheadChars;
  if (content.length <= budget) {
    return [{ index: 1, total: 1, phase: 'final', content }];
  }

  const chunks: string[] = [];
  let offset = 0;

  while (offset < content.length) {
    let end = Math.min(offset + CHUNK_TRANSCRIPT_CHARS, content.length);

    if (end < content.length) {
      const boundary = content.lastIndexOf('\n', end);
      const minBoundary = offset + Math.floor(CHUNK_TRANSCRIPT_CHARS * 0.75);
      if (boundary > minBoundary) {
        end = boundary + 1;
      }
    }

    chunks.push(content.slice(offset, end));
    offset = end;
  }

  const total = chunks.length;
  return chunks.map((chunk, index) => ({
    index: index + 1,
    total,
    phase: index === 0 ? 'opening' : index === total - 1 ? 'final' : 'middle',
    content: chunk,
  }));
}

export function buildExtractionSystemPrompt(): string {
  return `You are a sales transcript analyst for a human-in-the-loop GTM collateral workflow.

Your job is recall-oriented extraction: find the highest-signal customer problems, buying triggers, requested collateral, and requested capabilities that should influence follow-up content.

Extraction rules:
- Read the whole available transcript before deciding. Cover the beginning, middle, and final segment.
- Prioritize the customer's own words over seller claims.
- Treat explicit asks near the end of the call as high-signal context, especially requests for a deck, one-pager, demo, technical walkthrough, security details, integration details, or capability list.
- If the customer asks for a deck or capabilities, include that ask in the relevant pain point context rather than dropping it as logistics.
- Keep pain points distinct. Do not split the same problem into duplicates.
- Use exact customer wording for quote. If no exact quote supports a candidate, do not include that candidate.

Output your findings as valid JSON only. No prose, no markdown, no explanation. Return a JSON object with this exact structure:
{
  "companyName": "string or null",
  "painPoints": [
    {
      "severity": "low | medium | high | critical",
      "context": "concise summary including requested collateral or capabilities when relevant",
      "quote": "exact customer words"
    }
  ]
}`;
}

export function buildExtractionUserMessage(
  content: string,
  feedback: string | undefined,
  options: BuildExtractionUserMessageOptions = {}
): string {
  const chunkPosition = options.chunk
    ? `<chunk_position>
Chunk ${options.chunk.index} of ${options.chunk.total}: ${options.chunk.phase}
</chunk_position>
`
    : '';
  const previousPainPoints =
    options.previousPainPoints !== undefined && options.previousPainPoints.length > 0
      ? `<previous_candidates>
${JSON.stringify(options.previousPainPoints)}
</previous_candidates>
`
      : '';
  const sanitizedFeedback = feedback?.trim().replace(/<\//g, '');
  const refinement = sanitizedFeedback
    ? `\n<refinement_direction>\n${sanitizedFeedback}\n</refinement_direction>\n`
    : '';
  const task =
    options.chunk && options.chunk.total > 1
      ? `Update the candidate set using the current transcript chunk.
Use previous candidates only to avoid duplicates and to recognize repeated or strengthened evidence.
Return the top 5 pain points across the previous candidates and current chunk.`
      : `Extract up to 5 distinct pain points from the transcript.`;

  return `${chunkPosition}${previousPainPoints}<transcript>
${content}
</transcript>
${refinement}
<task>
${task}
Identify the prospect company name if mentioned.
Return JSON only.
</task>`;
}

async function runExtractionAgent(
  source: InferenceSource,
  systemPrompt: string,
  userMessage: string,
  workflowId: string,
  principalId: string,
  grantStore: GrantStore,
  tenantId: string,
  maxOutputTokens?: number
): Promise<LLMResponse> {
  const reply = await runSingleTurnAgent(
    source,
    systemPrompt,
    userMessage,
    'gtm-extraction',
    principalId,
    grantStore,
    tenantId,
    maxOutputTokens
  );
  log.info('LLM response received', { length: reply.length });

  let parsed: LLMResponse;
  try {
    // Try to parse the response directly
    parsed = JSON.parse(reply) as LLMResponse;
  } catch {
    // Fallback: extract JSON from response if wrapped in markdown or text
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.error('LLM extraction returned no JSON', {
        workflowId,
        raw: reply.substring(0, 500),
      });
      throw new Error('LLM returned no JSON for pain point extraction');
    }

    try {
      parsed = JSON.parse(jsonMatch[0]) as LLMResponse;
    } catch (extractError) {
      log.error('LLM extraction returned malformed JSON', {
        workflowId,
        extracted: jsonMatch[0].substring(0, 500),
        error: extractError instanceof Error ? extractError.message : String(extractError),
      });
      throw new Error('LLM returned malformed JSON for pain point extraction');
    }
  }

  if (!Array.isArray(parsed.painPoints)) {
    log.error('LLM response missing painPoints array', {
      workflowId,
      received: typeof parsed.painPoints,
    });
    throw new Error('LLM response missing painPoints array');
  }

  return parsed;
}

function serializeExtractionResult(
  workflowId: string,
  parsed: LLMResponse,
  companyName: string | null
): ExtractionResult {
  log.info('Pain points extracted', { count: parsed.painPoints.length, companyName });

  const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

  return {
    companyName,
    painPoints: parsed.painPoints.map((p) => {
      if (!VALID_SEVERITIES.includes(p.severity as (typeof VALID_SEVERITIES)[number])) {
        log.error('Unknown severity from LLM', { workflowId, raw: p.severity });
        throw new Error(`LLM returned unknown severity: ${p.severity}`);
      }
      return {
        sessionId: workflowId,
        severity: p.severity as (typeof VALID_SEVERITIES)[number],
        context: p.context,
        quote: p.quote,
        selected: true,
      };
    }),
  };
}

export async function extractPainPointsWithLLM(
  workflowId: string,
  content: string,
  feedback: string | undefined,
  source: InferenceSource,
  principalId: string,
  grantStore: GrantStore,
  tenantId: string,
  maxOutputTokens?: number
): Promise<ExtractionResult> {
  const model = source.model;

  log.info('Starting LLM extraction', { workflowId, transcriptLength: content.length, model });

  const systemPrompt = buildExtractionSystemPrompt();
  const sanitizedFeedback = feedback?.trim().replace(/<\//g, '');
  const feedbackOverheadChars = sanitizedFeedback
    ? sanitizedFeedback.length + '\n<refinement_direction>\n\n</refinement_direction>\n'.length
    : 0;
  const chunks = splitTranscriptForExtraction(content, feedbackOverheadChars);
  log.info('Prepared extraction chunks', {
    workflowId,
    chunkCount: chunks.length,
    assumedContextWindowTokens: ASSUMED_CONTEXT_WINDOW_TOKENS,
  });

  let parsed: LLMResponse | null = null;
  let bestCompanyName: string | null = null;

  for (const chunk of chunks) {
    const previousPainPoints = chunks.length > 1 ? parsed?.painPoints : undefined;
    const messageOptions: BuildExtractionUserMessageOptions = {
      chunk,
      ...(previousPainPoints !== undefined ? { previousPainPoints } : {}),
    };
    const userMessage = buildExtractionUserMessage(chunk.content, feedback, messageOptions);
    parsed = await runExtractionAgent(
      source,
      systemPrompt,
      userMessage,
      workflowId,
      principalId,
      grantStore,
      tenantId,
      maxOutputTokens
    );
    if (parsed.companyName && !bestCompanyName) {
      bestCompanyName =
        typeof parsed.companyName === 'string' && parsed.companyName.trim()
          ? parsed.companyName.trim()
          : null;
    }
    log.info('Extraction chunk processed', {
      workflowId,
      chunkIndex: chunk.index,
      chunkCount: chunk.total,
      candidateCount: parsed.painPoints.length,
    });
  }

  if (!parsed) {
    throw new Error('No extraction chunks were processed');
  }

  return serializeExtractionResult(workflowId, parsed, bestCompanyName);
}

export async function extractPainPoints(
  workflowId: string,
  content: string,
  feedback: string | undefined,
  source: InferenceSource,
  principalId: string,
  grantStore: GrantStore,
  tenantId: string,
  maxOutputTokens?: number
): Promise<ExtractionResult> {
  return extractPainPointsWithLLM(
    workflowId,
    content,
    feedback,
    source,
    principalId,
    grantStore,
    tenantId,
    maxOutputTokens
  );
}
