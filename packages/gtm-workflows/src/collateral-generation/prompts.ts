import {
  buildStructuredSystemPrompt,
  bulletList,
  structuredSection,
  xml,
} from "@workbench/prompts";

const PUBLIC_KINDS = [
  "linkedin-post",
  "twitter-post",
  "blog",
  "founder-pov-post",
  "one-pager",
  "case-study",
  "objection-handling",
  "customer-quotes",
  "battlecard",
] as const;

export function isPublicCollateralKind(type: string): boolean {
  return (PUBLIC_KINDS as readonly string[]).includes(type);
}

export function buildCollateralRulesBlock(type: string): string {
  const piiRules = isPublicCollateralKind(type)
    ? [
        "This is a PUBLIC artifact: it will be published or pasted where anyone can read it.",
        "Strip and generalise all customer identifying information.",
        "Never include customer or company names, people names, email addresses, domains, account handles, or any detail that could identify who the call was with.",
        "Replace specifics with category equivalents: a mid-market SaaS team, a VP of Engineering, a 50-person org.",
        "The result must read as a universal insight, not a case study about a named customer.",
      ]
    : [
        "This is a PRIVATE artifact: a follow-up note sent directly to the customer contact.",
        "Keep the real customer contact name and address them by their first name.",
        "It is correct to reference their company, their specific numbers, their timeline, and what they said on the call.",
        "Do not leak details about other customers or accounts.",
      ];

  return buildStructuredSystemPrompt([
    structuredSection("rules", bulletList(piiRules)),
    structuredSection(
      "style",
      bulletList([
        "No buzzwords: no synergy, leverage, unlock, streamline, game-changing, best-in-class.",
        "No em dashes. No superlatives. No hollow adjectives.",
        "Sentence case. Vary sentence length. Write how a person talks, not how a copywriter edits.",
      ]),
    ),
    structuredSection("output", [
      xml("field", "Short artifact title.", { name: "title" }),
      xml(
        "field",
        "Paste-ready artifact body, with newlines escaped as JSON string content.",
        {
          name: "body",
        },
      ),
    ]),
  ]);
}

function kindGuidance(type: string) {
  switch (type) {
    case "email":
      return [
        structuredSection(
          "role",
          "You are a seller writing a personal follow-up note to the contact you just spoke with. It should read like you typed it yourself right after the call, not a templated company recap.",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Subject line: 6-10 words, sentence case, references their specific situation.",
            "Greeting: Hi [First Name], on its own line, using the real contact name.",
            "Paragraph 1: thank them for the call in one natural line, no preamble.",
            "Paragraph 2: here is what I heard. Reflect back the specific problem they raised, in their terms.",
            "Paragraph 3: the next step actually discussed. One concrete action. Sign off with your first name only.",
          ]),
        ),
      ];
    case "linkedin-post":
      return [
        structuredSection(
          "role",
          "You are the seller writing a substantive, paste-ready LinkedIn post in first person for a professional audience.",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Open with a specific, concrete observation from the field. Never a question, never excitement filler.",
            "Develop the idea over several short paragraphs: what you saw, why it matters, and the pattern behind it.",
            "Land one sharp category insight that reframes a problem many teams face.",
            "Close with a single reflective line that invites the reader to think, not a CTA.",
          ]),
        ),
        structuredSection(
          "formatting",
          bulletList([
            "Paste-ready: clean single blank line between paragraphs.",
            "No hashtags and no emoji.",
            "150-250 words. Vary sentence length so it reads like a person talking, not a list of clipped lines.",
          ]),
        ),
      ];
    case "twitter-post":
    case "founder-pov-post":
      return [
        structuredSection(
          "role",
          "You are the seller writing a short, paste-ready social post in first person.",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Hook first with a specific, concrete observation. Never a question, never excitement filler.",
            "Write 3-4 short paragraphs that build to one sharp category insight about a problem many teams face.",
            "End with one sentence that invites reflection, not a CTA.",
          ]),
        ),
        structuredSection(
          "formatting",
          bulletList([
            "Paste-ready: clean single blank line between paragraphs.",
            "No hashtags and no emoji.",
            "Sentences under 20 words each.",
          ]),
        ),
      ];
    case "one-pager":
      return [
        structuredSection(
          "role",
          "You are writing a sales one-pager a rep hands to a buyer. It must stand on its own and sell the offering, not read like a mini-blog post.",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Headline: the core value proposition in one line, leading the page.",
            "The problem: the specific pain this buyer category feels, grounded in the call evidence.",
            "What it does: the differentiated capabilities that address that problem, as a short bulleted list.",
            "Use cases: two or three concrete situations where it applies.",
            "Proof: generalised social proof or evidence such as the outcome a comparable team saw, with no named customers.",
            "Call to action: one clear, concrete next step.",
          ]),
        ),
        structuredSection(
          "formatting",
          bulletList([
            "Use clear markdown headers (##) for each section.",
            "Lead with the value proposition, not the problem.",
            "Specific and concrete throughout. No filler sections.",
          ]),
        ),
      ];
    case "blog":
    case "case-study":
    case "objection-handling":
    case "customer-quotes":
      return [
        structuredSection(
          "role",
          "You are writing a useful GTM document the reader can share internally or turn into collateral.",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Use clear markdown headers.",
            "Start with the problem, then evidence, then recommended next step.",
            "Make each section actionable and specific.",
          ]),
        ),
      ];
    case "battlecard":
      return [
        structuredSection(
          "role",
          "You are writing paid ad copy with 4 variants for a paid media handoff.",
        ),
        structuredSection(
          "format",
          xml(
            "table",
            "Markdown table with columns: Variant | Headline | Body | CTA.",
          ),
        ),
      ];
    default:
      return [
        structuredSection(
          "role",
          `You are writing concise, paste-ready GTM collateral for the selected format: ${type}.`,
        ),
      ];
  }
}

export function buildCollateralSystemPrompt(type: string): string {
  return buildStructuredSystemPrompt([
    ...kindGuidance(type),
    structuredSection("ruleset", buildCollateralRulesBlock(type)),
  ]);
}
