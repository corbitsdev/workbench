import {
  buildStructuredSystemPrompt,
  bulletList,
  structuredSection,
  xml,
} from "@workbench/prompts";

/** Content types supported in v1. Cap selection at MAX_CONTENT_TYPES. */
export const CONTENT_TYPES = [
  { id: "linkedin-post", label: "LinkedIn post" },
  { id: "linkedin-article", label: "LinkedIn article" },
  { id: "twitter-post", label: "Twitter/X post" },
  { id: "twitter-article", label: "Twitter/X article" },
  { id: "blog-short", label: "Short blog" },
  { id: "blog-mid", label: "Mid blog" },
  { id: "blog-long", label: "Long blog" },
] as const;

export type ContentTypeId = (typeof CONTENT_TYPES)[number]["id"];

export const MAX_CONTENT_TYPES = 8;

const STYLE_RULES = [
  "No buzzwords: no synergy, leverage, unlock, streamline, game-changing, best-in-class.",
  "No em dashes. No superlatives. No hollow adjectives.",
  "Sentence case. Vary sentence length. Write how a person talks.",
  "Ground every claim in the provided source context.",
  "This is a PUBLIC artifact: strip and generalise customer-identifying details (names, companies, emails, domains).",
];

function typeSections(contentType: ContentTypeId) {
  switch (contentType) {
    case "linkedin-post":
      return [
        structuredSection(
          "role",
          "You write a short LinkedIn post a founder or GTM lead would publish.",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Hook in the first two lines.",
            "One clear insight grounded in the sources.",
            "Close with a reflective question, not a hard CTA.",
            "Target 120–220 words.",
          ]),
        ),
      ];
    case "linkedin-article":
      return [
        structuredSection(
          "role",
          "You write a LinkedIn long-form article (not a short post).",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Opening narrative hook.",
            "2–4 sections with ## headers developing the argument.",
            "Concrete examples from source themes (generalised).",
            "Close with a practical takeaway.",
            "Target 600–1000 words.",
          ]),
        ),
      ];
    case "twitter-post":
      return [
        structuredSection(
          "role",
          "You write a single sharp Twitter/X post (not a thread).",
        ),
        structuredSection(
          "structure",
          bulletList([
            "One idea, punchy and specific.",
            "Under 280 characters when possible; hard cap 500.",
            "No hashtag spam. No emoji pile-on.",
          ]),
        ),
      ];
    case "twitter-article":
      return [
        structuredSection(
          "role",
          "You write a long-form X/Twitter article style piece.",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Strong title line then multi-section body.",
            "Scannable paragraphs and short sections.",
            "Target 400–800 words.",
          ]),
        ),
      ];
    case "blog-short":
      return [
        structuredSection("role", "You write a short blog post (~400–600 words)."),
        structuredSection(
          "structure",
          bulletList([
            "Hook, problem, insight, takeaway.",
            "Use ## headers sparingly.",
            "Conversational, specific, paste-ready markdown.",
          ]),
        ),
      ];
    case "blog-mid":
      return [
        structuredSection("role", "You write a mid-length blog post (~800–1200 words)."),
        structuredSection(
          "structure",
          bulletList([
            "Narrative arc with clear sections.",
            "Examples and practical advice.",
            "Markdown headers and clean paragraph breaks.",
          ]),
        ),
      ];
    case "blog-long":
      return [
        structuredSection(
          "role",
          "You write a long-form blog post (~1500–2200 words).",
        ),
        structuredSection(
          "structure",
          bulletList([
            "Deep dive: context, problem, analysis, recommendations.",
            "Multiple ## sections; optional ### subsections.",
            "Still paste-ready and human, not academic.",
          ]),
        ),
      ];
  }
}

/** Default system-prompt body for one content type (without shared output contract). */
export function defaultPromptForType(contentType: ContentTypeId): string {
  return buildStructuredSystemPrompt([
    ...typeSections(contentType),
    structuredSection("style", bulletList(STYLE_RULES)),
  ]);
}

export function defaultPromptsByType(): Record<ContentTypeId, string> {
  const out = {} as Record<ContentTypeId, string>;
  for (const { id } of CONTENT_TYPES) {
    out[id] = defaultPromptForType(id);
  }
  return out;
}

const OUTPUT_CONTRACT = buildStructuredSystemPrompt([
  structuredSection(
    "output",
    [
      "The input is a JSON object. Fields include: contentType (or format), sourceContext, optional audience/tone/goal/titleHint, optional systemPrompt override notes, and for regenerate: previousContent + feedback.",
      "If systemPrompt is present and non-empty, treat it as additional authoring instructions for this piece (it supplements, does not replace, the format guidance).",
      "If feedback and previousContent are present, revise the previous draft to address the feedback while keeping the same content type.",
      "Return strict JSON only — no markdown fences, no preamble. Match this exact shape:",
      xml("field", "Content type id (same as input contentType or format).", {
        name: "format",
      }),
      xml("field", "Short artifact title (plain text).", { name: "title" }),
      xml(
        "field",
        "Paste-ready body. Escape newlines as \\n within the JSON string.",
        { name: "content" },
      ),
      "Never echo instruction tags or prompt scaffolding into the content.",
    ],
    { format: "json", fences: "false" },
  ),
]);

/** Static system prompt for the generate / regenerate inference steps. */
export function buildGenerationSystemPrompt(): string {
  const blocks = CONTENT_TYPES.map(({ id }) =>
    buildStructuredSystemPrompt([
      structuredSection("format-name", id),
      ...typeSections(id),
      structuredSection("style", bulletList(STYLE_RULES)),
    ]),
  ).join("\n\n");

  return [
    "You draft GTM collateral from mixed source material (artifacts, call notes, Linear tickets, free text).",
    "Read the contentType (or format) field. Find the matching <format-name> block and apply its role, structure, and style.",
    "Honor optional audience, tone, goal, and titleHint fields when present.",
    "Honor optional systemPrompt field as extra per-piece authoring instructions.",
    "When regenerating, apply feedback against previousContent.",
    "",
    blocks,
    "",
    OUTPUT_CONTRACT,
  ].join("\n");
}
