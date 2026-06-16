import {
  LINKEDIN_WRITING_SECTIONS,
  buildStructuredSystemPrompt,
  bulletList,
  structuredSection,
  xml,
} from '@workbench/prompts';

const PUBLIC_KINDS = [
  'linkedin-post',
  'linkedin-daily',
  'twitter-post',
  'blog',
  'founder-pov-post',
  'one-pager',
  'case-study',
  'objection-handling',
  'customer-quotes',
  'battlecard',
] as const;

export function isPublicCollateralKind(type: string): boolean {
  return (PUBLIC_KINDS as readonly string[]).includes(type);
}

export function buildCollateralRulesBlock(type: string): string {
  const piiRules = isPublicCollateralKind(type)
    ? [
        'This is a PUBLIC artifact: it will be published or pasted where anyone can read it.',
        'Strip and generalise all customer identifying information.',
        'Never include customer or company names, people names, email addresses, domains, account handles, or any detail that could identify who the call was with.',
        'Replace specifics with category equivalents: a mid-market SaaS team, a VP of Engineering, a 50-person org.',
        'The result must read as a universal insight, not a case study about a named customer.',
      ]
    : [
        'This is a PRIVATE artifact: a follow-up note sent directly to the customer contact.',
        'Keep the real customer contact name and address them by their first name.',
        'It is correct to reference their company, their specific numbers, their timeline, and what they said on the call.',
        'Do not leak details about other customers or accounts.',
      ];

  return buildStructuredSystemPrompt([
    structuredSection('rules', bulletList(piiRules)),
    structuredSection(
      'style',
      bulletList([
        'No buzzwords: no synergy, leverage, unlock, streamline, game-changing, best-in-class.',
        'No em dashes. No superlatives. No hollow adjectives.',
        'Sentence case. Vary sentence length. Write how a person talks, not how a copywriter edits.',
      ])
    ),
    structuredSection(
      'output',
      [
        'Return a single JSON object with exactly two keys: "title" and "body". No markdown fences, no preamble, no trailing text — raw JSON only.',
        'Never echo the XML tags used in these instructions (such as role, structure, formatting, rules, output, field, or item) into the body. Emit only the requested content.',
        xml('field', 'Short artifact title (plain text, no quotes).', { name: 'title' }),
        xml(
          'field',
          'Paste-ready artifact body. Escape newlines as \\n within the JSON string value.',
          {
            name: 'body',
          }
        ),
      ],
      { format: 'json', fences: 'false' }
    ),
  ]);
}

const LINKEDIN_DAILY_HOOK_VARIANTS = [
  'Open with a scene from the field: a specific moment, conversation, or observation that makes the reader feel like they were in the room.',
  'Open with a statement that challenges a common assumption. Make the reader stop and reconsider something they thought they understood.',
  'Open by naming a pattern you have noticed across multiple conversations or situations — specific enough to be credible, broad enough that others recognise it.',
];

function kindGuidance(type: string, variantIndex = 0) {
  switch (type) {
    case 'email':
      return [
        structuredSection(
          'role',
          'You are a seller writing a personal follow-up note to the contact you just spoke with. It should read like you typed it yourself right after the call, not a templated company recap.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'Subject line: 6-10 words, sentence case, references their specific situation.',
            'Greeting: Hi [First Name], on its own line, using the real contact name.',
            'Paragraph 1: thank them for the call in one natural line, no preamble.',
            'Paragraph 2: here is what I heard. Reflect back the specific problem they raised, in their terms.',
            'Paragraph 3: the next step actually discussed. One concrete action. Sign off with your first name only.',
          ])
        ),
      ];
    case 'linkedin-post':
      return [
        structuredSection(
          'role',
          'You are the seller writing a substantive, paste-ready LinkedIn post in first person for a professional audience.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'Open with a specific, concrete observation from the field. Never a question, never excitement filler.',
            'Develop the idea over several short paragraphs: what you saw, why it matters, and the pattern behind it.',
            'Land one sharp category insight that reframes a problem many teams face.',
            'Close with a single reflective line that invites the reader to think, not a CTA.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Paste-ready: clean single blank line between paragraphs.',
            'No hashtags and no emoji.',
            '150-250 words. Vary sentence length so it reads like a person talking, not a list of clipped lines.',
          ])
        ),
      ];
    case 'linkedin-daily': {
      const hookInstruction =
        LINKEDIN_DAILY_HOOK_VARIANTS[variantIndex % LINKEDIN_DAILY_HOOK_VARIANTS.length];
      if (!hookInstruction) throw new Error(`No hook variant for index ${variantIndex}`);
      return [...LINKEDIN_WRITING_SECTIONS, structuredSection('hook-style', hookInstruction)];
    }
    case 'twitter-post':
    case 'founder-pov-post':
      return [
        structuredSection(
          'role',
          'You are the seller writing a short, paste-ready social post in first person.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'Hook first with a specific, concrete observation. Never a question, never excitement filler.',
            'Write 3-4 short paragraphs that build to one sharp category insight about a problem many teams face.',
            'End with one sentence that invites reflection, not a CTA.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Paste-ready: clean single blank line between paragraphs.',
            'No hashtags and no emoji.',
            'Sentences under 20 words each.',
          ])
        ),
      ];
    case 'one-pager':
      return [
        structuredSection(
          'role',
          'You are writing a sales one-pager a rep hands to a buyer. It must stand on its own and sell the offering, not read like a mini-blog post.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'Headline: the core value proposition in one line, leading the page.',
            'The problem: the specific pain this buyer category feels, grounded in the call evidence.',
            'What it does: the differentiated capabilities that address that problem, as a short bulleted list.',
            'Use cases: two or three concrete situations where it applies.',
            'Proof: generalised social proof or evidence such as the outcome a comparable team saw, with no named customers.',
            'Call to action: one clear, concrete next step.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Use clear markdown headers (##) for each section.',
            'Lead with the value proposition, not the problem.',
            'Specific and concrete throughout. No filler sections.',
          ])
        ),
      ];
    case 'blog':
      return [
        structuredSection(
          'role',
          'You are writing a compelling blog post with a narrative arc, not an analytical document. Write in first or second person, as if telling a story.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'Hook: Open with a personal observation, relatable scenario, or concrete problem from the field.',
            'Story: Develop the narrative from problem to solution. Show the progression, not just state the conclusion.',
            'Lessons: Conclude with what the reader should take away. Make it personal and reflective.',
            'Tone: Conversational, specific, and grounded. Not analytical or report-like.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Use clear markdown headers (##) to structure sections.',
            'Paste-ready with clean paragraph breaks.',
            'Vary sentence length. Write how a person talks, not how a marketing team edits.',
          ])
        ),
      ];
    case 'case-study':
      return [
        structuredSection(
          'role',
          "You are writing a customer case study: a success story showing challenge, solution, and measurable results. Use the customer's voice and specific metrics."
        ),
        structuredSection(
          'structure',
          bulletList([
            'Customer & Context: Who they are, their situation, what team or function they belong to.',
            'Challenge: The specific problem they faced. Grounded in the call, in their terms.',
            'Solution: What was implemented and how it addressed the challenge.',
            'Results: Measurable outcomes—time saved, cost reduced, quality improved, or velocity increased.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Use clear markdown headers (##) for each section.',
            'Include specific numbers and metrics. Avoid generalizations.',
            'This is a success story. Let the positive outcome come through clearly.',
          ])
        ),
      ];
    case 'objection-handling':
      return [
        structuredSection(
          'role',
          'You are writing an objection-handling guide: a tactical reference for sellers to rebut common objections with evidence and examples.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'For each objection: State it clearly as a buyer might raise it.',
            'Response: Provide a direct, conversational rebuttal. Address the concern head-on.',
            'Proof: Cite proof points—evidence, outcomes, or patterns from customers.',
            'Example: Give a concrete scenario that makes the response real and actionable.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Format for sales readiness. This is a tactical tool, not a narrative.',
            'Use clear headers and short, scannable sections.',
            'Each objection should be a complete unit a rep can use immediately.',
          ])
        ),
      ];
    case 'customer-quotes':
      return [
        structuredSection(
          'role',
          'You are curating verbatim customer quotes that illustrate key themes. Let quotes speak for themselves—no paraphrasing or narrative commentary.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'Quote: Exact verbatim text from the call, in quotation marks.',
            'Attribution: Who said it (name, title, company). Generalise company if needed (e.g., "mid-market SaaS team").',
            'Context: When and why they said it. What problem or situation prompted the comment.',
            'Theme: What theme or insight this quote supports.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Each quote is a distinct unit with all four elements.',
            "No paraphrasing. No editorializing. Let the customers' own words do the work.",
            'Use clear formatting to separate quote, attribution, context, and theme.',
          ])
        ),
      ];
    case 'battlecard':
      return [
        structuredSection(
          'role',
          'You are writing a competitive battlecard: a reference guide for sellers to position against competitors and respond to competitive claims.'
        ),
        structuredSection(
          'structure',
          bulletList([
            'Competitor or Scenario: Name the competitor or competitive positioning to address.',
            'Their Claim: What they claim about their product, approach, or advantage.',
            'Our Differentiation: How we position differently. What is our actual advantage.',
            'Proof Points: Evidence, outcomes, or capabilities that support our positioning.',
          ])
        ),
        structuredSection(
          'formatting',
          bulletList([
            'Format as a reference guide for sales, not paid media copy.',
            'Use clear headers so reps can scan and find what they need quickly.',
            'Each competitor is a complete unit with all four elements.',
            'Tone is factual and direct. No superlatives or hype.',
          ])
        ),
      ];
    default:
      return [
        structuredSection(
          'role',
          `You are writing concise, paste-ready GTM collateral for the selected format: ${type}.`
        ),
      ];
  }
}

export function buildCollateralSystemPrompt(type: string, variantIndex = 0): string {
  return buildStructuredSystemPrompt([
    ...kindGuidance(type, variantIndex),
    structuredSection('ruleset', buildCollateralRulesBlock(type)),
  ]);
}
