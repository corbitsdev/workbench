import { getLogger } from '@intx/log';
import type { ArtifactKind } from '@workbench/shared';
import { buildInferenceSource, runSingleTurnAgent } from './inference';

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

const PUBLIC_KINDS = ['linkedin', 'one-pager', 'battlecard'] as const;

export function isPublicKind(type: ArtifactKind): boolean {
  return (PUBLIC_KINDS as readonly ArtifactKind[]).includes(type);
}

export function buildRulesBlock(type: ArtifactKind): string {
  const piiRules = isPublicKind(type)
    ? `This is a PUBLIC artifact: it will be published or pasted where anyone can read it.
- Strip and generalise ALL customer identifying information. Never include customer or company names, people's names, email addresses, domains, account handles, or any detail that could identify who the call was with.
- Replace specifics with category equivalents: "a mid-market SaaS team", "a VP of Engineering", "a 50-person org". Numbers and patterns are fine only when they cannot be traced back to one company.
- The result must read as a universal insight, not a case study about a named customer.`
    : `This is a PRIVATE artifact: a follow-up note sent directly to the customer contact.
- Keep the real customer contact name and address them by their first name.
- It is correct to reference their company, their specific numbers, their timeline, and what they said on the call. This message is for them.
- Do not leak details about other customers or accounts.`;

  return `<rules>
${piiRules}
</rules>

<style>
- No buzzwords: no "synergy", "leverage", "unlock", "streamline", "game-changing", "best-in-class".
- No em dashes. No superlatives. No hollow adjectives.
- Sentence case. Vary sentence length. Write how a person talks, not how a copywriter edits.
</style>

<output>
Return ONLY valid JSON, with no markdown fences and no prose, in exactly this shape: {"title": "...", "body": "..."} with any newlines inside body written as \\n.
</output>`;
}

function buildKindGuidance(type: ArtifactKind): string {
  switch (type) {
    case 'email':
      return `<role>
You are a seller writing a personal follow-up note to the contact you just spoke with. It should read like you typed it yourself right after the call, not a templated company recap.
</role>

<structure>
- Subject line: 6-10 words, sentence case, references their specific situation.
- Greeting: "Hi [First Name]," on its own line, using the real contact name.
- Paragraph 1: thank them for the call in one natural line, no preamble.
- Paragraph 2: "here's what I heard" — reflect back the specific problem they raised, in their terms. Use their numbers or timeline if you have them.
- Paragraph 3: the next step you actually discussed (for example the Slack channel, the doc, the intro). One concrete action. Sign off with your first name only.
</structure>

<tone>
- First person, warm, specific to this call. Not a "who we are" recap.
- Use their exact quote once only if it lands; otherwise paraphrase naturally.
- No "I hope this finds you well", no "excited to share", no "just reaching out".
</tone>`;

    case 'linkedin':
      return `<role>
You are the seller writing a short, paste-ready LinkedIn post in first person.
</role>

<structure>
- Hook first: open with a specific, concrete observation — a number, a pattern, a situation. Never a question, never "I'm excited to share".
- 3-4 short paragraphs that build to one sharp category insight about a problem many teams face.
- End with one sentence that invites reflection, not a CTA.
</structure>

<formatting>
- Paste-ready: clean single blank line between paragraphs, no walls of text.
- No hashtags, no emoji, no hashtag spam.
- Sentences under 20 words each.
</formatting>`;

    case 'one-pager':
      return `<role>
You are writing a one-pager the reader can share internally or drop into a deck.
</role>

<structure>
Use these exact markdown headers, in this order:
## The Problem
## The Impact
## How We Help
## Proof
## Next Step
</structure>

<guidance>
- The Problem: name the problem clearly in one tight paragraph.
- The Impact: what it costs them — time, money, risk. Quantify with generalised numbers where possible.
- How We Help: 3-5 bullets, each a specific capability tied to the problem, no generic benefits.
- Proof: the evidence that this works — a pattern, a result, a credible reference. Keep it customer-agnostic.
- Next Step: one sentence, one concrete action.
</guidance>`;

    case 'battlecard':
      return `<role>
You are writing paid ad copy with 4 variants for a paid media handoff. Each variant takes a different angle on the same pain.
</role>

<variants>
Use all four:
- Variant A: Consequence — what happens if nothing changes.
- Variant B: Social proof — what others in this situation discovered.
- Variant C: Aspiration — what the world looks like when this is solved.
- Variant D: Directness — call out exactly what is broken.
</variants>

<format>
- Markdown table with columns: Variant | Headline | Body | CTA.
- Headline: 8 words max, specific. Body: 2-3 tight sentences. CTA: specific active verb, not "Learn more".
</format>`;

    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown collateral type: ${String(_exhaustive)}`);
    }
  }
}

function buildSystemPrompt(type: ArtifactKind): string {
  return `${buildKindGuidance(type)}

${buildRulesBlock(type)}`;
}

export async function generateCollateralWithLLM(
  workflowId: string,
  transcript: string,
  point: PainPointInput,
  type: ArtifactKind
): Promise<GeneratedCollateral> {
  log.info('Generating collateral', { workflowId, painPointId: point.id, type });

  // TODO(CL-1373): resolve via resolveCredentialRequirement from @intx/db once workflows
  // are tenant-aware (blocked by CL-1246). Currently uses platform operator key for all tenants.
  const source = buildInferenceSource(`generation-${workflowId}`);

  const userMessage = `Transcript (for context):\n\n${transcript.slice(0, 60000)}\n\n---\n\nPain point to address:\n- Summary: ${point.context}\n- Severity: ${point.severity}\n- Verbatim quote: "${point.quote}"\n\nGenerate the ${type} collateral now.`;

  const raw = await runSingleTurnAgent(
    source,
    buildSystemPrompt(type),
    userMessage,
    'gtm-generation'
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
