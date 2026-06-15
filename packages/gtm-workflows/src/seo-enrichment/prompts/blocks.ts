// Composable appended blocks. Each PromptBlock is reference-only guidance that
// is fenced (spotlighted) when assembled, so it can never be mistaken for CORE.

export interface PromptBlock {
  // Stable identifier (used for selection / debugging).
  id: string;
  // Human-readable label shown on the fence envelope.
  label: string;
  // The block body. Reference-only guidance.
  body: string;
}

export const BRAND_VOICE_BLOCK: PromptBlock = {
  id: 'brand-voice',
  label: 'BRAND VOICE',
  body: [
    "Write in The Knot's brand voice: warm, celebratory, and tasteful.",
    'Speak to couples planning their wedding. Favor evocative but concrete',
    'language over hype. Avoid cliches, exclamation overload, and pushy sales',
    'phrasing. Keep it inclusive and modern.',
  ].join(' '),
};

export const LEGAL_BLOCK: PromptBlock = {
  id: 'legal',
  label: 'LEGAL',
  body: [
    'Do not make unverifiable claims (for example guarantees, superlatives',
    'like "best" or "#1", health/safety claims, or pricing/discount promises).',
    'Do not reference third-party trademarks. Do not imply endorsements. Only',
    'state product attributes that are present in the supplied metadata.',
  ].join(' '),
};

// SEO/GEO encodes The Knot's copy format as voice guidance. The reference
// format has five parts: Romance Copy, Static Copy, Additional Details, Size,
// Keywords. Our three outputs map onto that format as noted below.
export const SEO_GEO_BLOCK: PromptBlock = {
  id: 'seo-geo',
  label: 'SEO/GEO',
  body: [
    'Follow The Knot copy format as voice guidance for the three outputs:',
    '',
    '- Romance Copy: emotive, scene-setting language describing how the piece',
    '  feels at the celebration. Drives the SUMMARY and the opening of the',
    '  SEO meta description (PRODUCT_METADATA_DESCRIPTION).',
    '- Static Copy: factual, attribute-led description (what it is, how it is',
    '  used). Balances the romance copy in the description and summary.',
    '- Additional Details: secondary attributes (personalization, pairing',
    '  suggestions) woven in only when present in metadata.',
    '- Size: include dimensions only when supplied; never invent them.',
    '- Keywords: weave natural wedding-stationery search terms into the SEO',
    '  title (PRODUCT_METADATA_TITLE) and description without keyword stuffing.',
    '',
    'The description and summary should follow the romance + static voice: lead',
    'with romance, ground with static fact. Titles stay keyword-forward and',
    'within the character target.',
  ].join('\n'),
};

// The base blocks appended to CORE on every assemble, in order.
export const DEFAULT_BLOCKS: readonly PromptBlock[] = [
  BRAND_VOICE_BLOCK,
  LEGAL_BLOCK,
  SEO_GEO_BLOCK,
];
