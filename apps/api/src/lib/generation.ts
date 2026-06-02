import { createAgent } from '@intx/agent';
import { getLogger } from '@intx/log';
import type { InferenceSource } from '@intx/types/runtime';
import type { CollateralType } from '@gtm/workbench-shared';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function buildSystemPrompt(type: CollateralType): string {
  switch (type) {
    case 'email':
      return `You are a senior outbound sales rep. Write a follow-up email from the seller to the primary prospect contact. It must read like a human wrote it — not a template, not a robot.

Structure (mandatory):
- Subject line: 6-10 words, sentence case, references their specific situation — not a generic value prop
- Greeting: Hi [First Name], on its own line
- Paragraph 1 (1-2 sentences): One punchy observation grounded in what they said on the call. No intro, no preamble.
- Paragraph 2 (2 sentences max): What solving this unlocks for them specifically. Use their numbers or timeline if you have them.
- Paragraph 3 (1-2 sentences): One concrete next step with a specific day or action. Sign off with your name only.

Humanizer rules (non-negotiable):
- Vary sentence length — mix short punchy lines with one slightly longer one
- Write how a person talks, not how a copywriter edits
- No "I hope this finds you well". No "excited to share". No "just reaching out". No "synergy". No "leverage".
- No em dashes. No superlatives. No hollow adjectives.
- Use the prospect's exact quote once if it lands a punch — otherwise paraphrase naturally
- Sentence case everywhere

Return JSON: { "title": "<subject line>", "body": "<full email text, newlines as \\n>" }`;

    case 'linkedin':
      return `You are a senior sales copywriter. Write a short-form LinkedIn post from the seller's first-person perspective.

Structure:
- Open with a specific, concrete observation — a number, a pattern, a situation. Never a question. Never "I'm excited to share."
- Tell the story in 3-4 short paragraphs. Build to a single sharp category insight about a problem many companies face.
- End with one sentence that invites reflection. Not a sales pitch. Not a CTA.

Rules (non-negotiable):
- First person throughout
- NEVER mention client names, company names, prospect names, or any identifying details. Generalise everything to a category or job function (e.g. "a mid-market SaaS team", "a VP of Sales", "a 50-person org").
- Use patterns and numbers from the transcript but strip all attribution — make the insight feel universal, not like a case study.
- No hashtags. No emoji. No "game-changing". No "synergy". No "unlock".
- Sentences under 20 words each
- White space between paragraphs — no walls of text
- The insight should feel earned, not announced

Return JSON: { "title": "<5-8 word post headline>", "body": "<full post text, newlines as \\n>" }`;

    case 'one-pager':
      return `You are a senior sales copywriter. Write a structured one-pager the prospect can share internally or paste into a deck.

Structure (use these exact markdown headers):
## The Problem
## The Evidence
## What We Deliver
## The Math
## Next Step

Rules:
- Every section must use the prospect's specific situation: their numbers, team size, timeline, exact quotes
- "The Evidence" section: name the incident, the dollar figure, the timeline — make it undeniable
- "The Math" section: show the savings calculation with their actual spend numbers
- "What We Deliver": 3-5 bullet points, each one a specific capability tied to their pain — no generic benefits
- "Next Step": one sentence, one action, specific
- No buzzwords. No "synergy". No "leverage". No "streamline".

Return JSON: { "title": "<action-oriented title, specific to their situation>", "body": "<full markdown body>" }`;

    case 'battlecard':
      return `You are a senior sales copywriter. Write paid ad copy with 4 variants for a paid media handoff (e.g. CircleClick). Each variant takes a different angle on the same pain.

Angles (use all four):
- Variant A: Consequence — what happens if nothing changes
- Variant B: Social proof — what others in this situation discovered
- Variant C: Aspiration — what the world looks like when this is solved
- Variant D: Directness — call out exactly what is broken and name it

Each variant: Headline (8 words max, specific — use their numbers or language), Body (2-3 tight sentences), CTA (specific verb, not "Learn more").

Format as a markdown table with columns: Variant | Headline | Body | CTA

Rules:
- Headlines must be specific. Generic headlines get rejected.
- No em dashes. No superlatives.
- CTAs: "See how teams ship" / "Get it live" / "Show me the path" — specific, active.

Return JSON: { "title": "<pain point + channel: Paid Ad Copy>", "body": "<full markdown table>" }`;
  }
}

export async function generateCollateralWithLLM(
  workflowId: string,
  transcript: string,
  point: PainPointInput,
  type: CollateralType
): Promise<GeneratedCollateral> {
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const model = process.env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1';

  if (!apiKey) {
    throw new Error('OPENAI_COMPATIBLE_API_KEY is required for collateral generation');
  }

  log.info('Generating collateral', { workflowId, painPointId: point.id, type });

  const source: InferenceSource = {
    id: `generation-${workflowId}`,
    provider: 'openai',
    baseURL,
    apiKey,
    model,
  };

  const userMessage = `Transcript (for context):\n\n${transcript.slice(0, 60000)}\n\n---\n\nPain point to address:\n- Summary: ${point.context}\n- Severity: ${point.severity}\n- Verbatim quote: "${point.quote}"\n\nGenerate the ${type} collateral now.`;

  const contextDir = join(tmpdir(), `gtm-generation-${randomUUID()}`);
  const agent = await createAgent({
    contextDir,
    sources: [source],
    defaultSource: source.id,
    systemPrompt: buildSystemPrompt(type),
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

  if (!raw) throw new Error('LLM returned empty content for collateral generation');

  let parsed: { title?: string; body?: string };
  try {
    parsed = JSON.parse(raw) as { title?: string; body?: string };
  } catch {
    log.error('Collateral generation returned invalid JSON', {
      workflowId,
      type,
      raw: raw.substring(0, 500),
    });
    throw new Error('LLM returned invalid JSON for collateral generation');
  }
  if (!parsed.title || !parsed.body) {
    log.error('Collateral generation missing title or body', { workflowId, type, raw });
    throw new Error('LLM response missing title or body');
  }

  log.info('Collateral generated', { workflowId, painPointId: point.id, type });

  return { title: parsed.title.slice(0, 500), body: parsed.body.slice(0, 10000) };
}
