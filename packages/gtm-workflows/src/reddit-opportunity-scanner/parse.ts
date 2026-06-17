import { type } from 'arktype';
import type { AnalyzeReply, ExportReply } from './types';

const analyzeReplySchema = type({
  whatTheySell: 'string',
  mainKeywords: 'string[]',
  competitors: 'string[]',
  'audienceNotes?': 'string',
  evidence: 'string[]',
  keywords: type({
    label: 'string',
    reason: 'string',
    confidence: 'number',
  }).array(),
  subreddits: type({
    label: 'string',
    reason: 'string',
    confidence: 'number',
  }).array(),
});

const exportReplySchema = type({
  channelBrief: 'string',
  responsePlaybook: 'string',
  opportunityFeed: 'string',
});

export function extractJsonFromReply(reply: string): unknown {
  try {
    return JSON.parse(reply);
  } catch {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('LLM returned no JSON');
    return JSON.parse(match[0]);
  }
}

export function parseAnalyzeReply(reply: string): AnalyzeReply {
  const raw = extractJsonFromReply(reply);
  const parsed = analyzeReplySchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid analyze reply: ${parsed.summary}`);
  }
  return parsed;
}

export function parseExportReply(reply: string): ExportReply {
  const raw = extractJsonFromReply(reply);
  const parsed = exportReplySchema(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Invalid export reply: ${parsed.summary}`);
  }
  return parsed;
}

export function extractMarkdownFromFirecrawlResult(raw: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return raw.trim();
  }
  if (typeof payload !== 'object' || payload === null) return raw.trim();
  const record = payload as Record<string, unknown>;
  const data = record['data'];
  if (typeof data === 'object' && data !== null) {
    const dataRecord = data as Record<string, unknown>;
    const markdown = dataRecord['markdown'];
    if (typeof markdown === 'string' && markdown.trim().length > 0) {
      return markdown.trim();
    }
  }
  const markdown = record['markdown'];
  if (typeof markdown === 'string' && markdown.trim().length > 0) {
    return markdown.trim();
  }
  return JSON.stringify(payload).slice(0, 5000);
}
