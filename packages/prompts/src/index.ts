export interface PromptSection {
  tag: string;
  content: string;
}

export interface PromptFormat {
  xml: boolean;
}

export const HUMANIZER_SECTION: PromptSection = {
  tag: 'output',
  content: `When producing output:
1. Identify AI patterns and replace them with natural alternatives. Cover everything the original covers.
2. Preserve meaning. Keep the core message intact.
3. Match the voice. Fit the intended tone (formal, casual, technical). Add personality only when the content and the author's voice call for it.
4. If the user's voice is known, match their patterns. If they write short sentences, don't produce long ones. If they use "stuff" and "things," don't upgrade to "elements" and "components."
5. Avoid: inflated significance, promotional language, superficial -ing analyses, vague attributions, em dash overuse, rule of three, AI vocabulary words, passive voice, negative parallelisms, filler phrases, and excessive hedging.
6. No emojis unless explicitly requested.`,
};

export function formatSection(section: PromptSection, format: PromptFormat): string {
  if (format.xml) {
    return `<${section.tag}>\n${section.content}\n</${section.tag}>`;
  }
  const title = section.tag.charAt(0).toUpperCase() + section.tag.slice(1);
  return `## ${title}\n${section.content}`;
}

export function buildSystemPrompt(sections: PromptSection[], format: PromptFormat): string {
  return sections.map((s) => formatSection(s, format)).join('\n\n');
}

export function buildContextBlock(
  context: { [key: string]: string | undefined },
  format: PromptFormat
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) {
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      lines.push(`${label}: ${value}`);
    }
  }
  const content = lines.join('\n');
  return formatSection({ tag: 'context', content }, format);
}

export type XmlValue = string | number | boolean | null | undefined | XmlNode | XmlValue[];

export interface XmlNode {
  tag: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  children?: XmlValue;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderAttrs(attrs: XmlNode['attrs']): string {
  if (!attrs) return '';
  const rendered = Object.entries(attrs)
    .filter(
      (entry): entry is [string, string | number | boolean] =>
        entry[1] !== null && entry[1] !== undefined
    )
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`);
  return rendered.length > 0 ? ` ${rendered.join(' ')}` : '';
}

export function xml(tag: string, children?: XmlValue, attrs?: XmlNode['attrs']): XmlNode {
  return {
    tag,
    ...(children !== undefined ? { children } : {}),
    ...(attrs !== undefined ? { attrs } : {}),
  };
}

export function renderXml(value: XmlValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(renderXml).filter(Boolean).join('\n');
  if (typeof value !== 'object') return escapeXml(String(value));

  const attrs = renderAttrs(value.attrs);
  const body = renderXml(value.children);
  if (!body) return `<${value.tag}${attrs} />`;
  return `<${value.tag}${attrs}>\n${body}\n</${value.tag}>`;
}

export interface StructuredPromptSection {
  tag: string;
  content: XmlValue;
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

export function structuredSection(
  tag: string,
  content: XmlValue,
  attrs?: StructuredPromptSection['attrs']
): StructuredPromptSection {
  return {
    tag,
    content,
    ...(attrs !== undefined ? { attrs } : {}),
  };
}

export function buildStructuredSystemPrompt(sections: StructuredPromptSection[]): string {
  return renderXml(sections.map((s) => xml(s.tag, s.content, s.attrs)));
}

export function bulletList(items: string[]): XmlValue[] {
  return items.map((item) => xml('item', item));
}

export function jsonOutputContract(shape: Record<string, string>): XmlNode {
  const fields = Object.entries(shape).map(([name, description]) =>
    xml('field', description, { name })
  );
  return xml('output', fields, { format: 'json', fences: false });
}

export const LINKEDIN_WRITING_SECTIONS: StructuredPromptSection[] = [
  structuredSection(
    'role',
    'You are writing in first person as a practitioner sharing a field observation with a professional audience. You are not a marketer. You are an operator who noticed something.'
  ),
  structuredSection(
    'structure',
    bulletList([
      'Open with a specific, concrete observation. Never a question. Never excitement filler.',
      'Develop the idea over several short paragraphs: what you saw, why it matters, the pattern behind it.',
      'Land one sharp category insight that reframes a problem many teams face.',
      'Close with a single reflective line. No call to action.',
    ])
  ),
  structuredSection(
    'formatting',
    bulletList([
      'Paste-ready: clean single blank line between paragraphs.',
      'No hashtags. No emoji.',
      'Sentence case throughout.',
      'No em dashes. No superlatives. No hollow adjectives.',
      '150-250 words. Vary sentence length so it reads like a person talking, not a list of clipped lines.',
    ])
  ),
  structuredSection(
    'voice',
    bulletList([
      'No buzzwords: no synergy, leverage, unlock, streamline, game-changing, best-in-class.',
      'No engagement bait: no "thoughts?", no manufactured urgency, no questions posed to the reader.',
      'Write how a sharp person talks to a peer, not how a marketing team edits copy.',
    ])
  ),
];
