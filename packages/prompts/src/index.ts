export interface PromptSection {
  tag: string;
  content: string;
}

export interface PromptFormat {
  xml: boolean;
}

export const HUMANIZER_SECTION: PromptSection = {
  tag: "output",
  content: `When producing output:
1. Identify AI patterns and replace them with natural alternatives. Cover everything the original covers.
2. Preserve meaning. Keep the core message intact.
3. Match the voice. Fit the intended tone (formal, casual, technical). Add personality only when the content and the author's voice call for it.
4. If the user's voice is known, match their patterns. If they write short sentences, don't produce long ones. If they use "stuff" and "things," don't upgrade to "elements" and "components."
5. Avoid: inflated significance, promotional language, superficial -ing analyses, vague attributions, em dash overuse, rule of three, AI vocabulary words, passive voice, negative parallelisms, filler phrases, and excessive hedging.
6. No emojis unless explicitly requested.`,
};

export function formatSection(
  section: PromptSection,
  format: PromptFormat,
): string {
  if (format.xml) {
    return `<${section.tag}>\n${section.content}\n</${section.tag}>`;
  }
  const title = section.tag.charAt(0).toUpperCase() + section.tag.slice(1);
  return `## ${title}\n${section.content}`;
}

export function buildSystemPrompt(
  sections: PromptSection[],
  format: PromptFormat,
): string {
  return sections.map((s) => formatSection(s, format)).join("\n\n");
}

export function buildContextBlock(
  context: { [key: string]: string | undefined },
  format: PromptFormat,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) {
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      lines.push(`${label}: ${value}`);
    }
  }
  const content = lines.join("\n");
  return formatSection({ tag: "context", content }, format);
}

// Runtime context shared by every agent so behaviour is unified: who the agent
// is acting for, the live calendar date, and any other locally-relevant facts.
// Fields are optional except the date — render only what is present so shared
// agents (no single user) and personal agents use the same block.
export interface ActiveContext {
  now: Date;
  userName?: string;
  // Additional labelled facts (e.g. workbench, timezone). Rendered verbatim in
  // insertion order beneath the standard fields. Keys must be non-numeric
  // labels (object key order is only guaranteed for string keys).
  extra?: Record<string, string>;
}

// Format a date as DD/MM/YYYY in UTC for a deterministic, server-side calendar
// date. Pass the current Date at call time — never bind a module-level
// constant, or the date freezes at process start.
export function formatDate(now: Date): string {
  const day = String(now.getUTCDate()).padStart(2, "0");
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const year = now.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

// Build the unified active-context block. A plain labelled section that reads
// correctly whether the host prompt is XML- or markdown-formatted, since it is
// appended as a trailing block rather than merged into the prompt's own
// sections.
export function buildActiveContext(context: ActiveContext): string {
  const lines = ["## Active Context"];
  if (context.userName) lines.push(`User: ${context.userName}`);
  lines.push(`Current date: ${formatDate(context.now)}`);
  if (context.extra) {
    for (const [label, value] of Object.entries(context.extra)) {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines.join("\n");
}

// Append the active-context block beneath an existing system prompt.
export function withActiveContext(systemPrompt: string, context: ActiveContext): string {
  return `${systemPrompt}\n\n${buildActiveContext(context)}`;
}

export type XmlValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | XmlNode
  | XmlValue[];

export interface XmlNode {
  tag: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  children?: XmlValue;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function renderAttrs(attrs: XmlNode["attrs"]): string {
  if (!attrs) return "";
  const rendered = Object.entries(attrs)
    .filter(
      (entry): entry is [string, string | number | boolean] =>
        entry[1] !== null && entry[1] !== undefined,
    )
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`);
  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
}

export function xml(
  tag: string,
  children?: XmlValue,
  attrs?: XmlNode["attrs"],
): XmlNode {
  return {
    tag,
    ...(children !== undefined ? { children } : {}),
    ...(attrs !== undefined ? { attrs } : {}),
  };
}

export function renderXml(value: XmlValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value))
    return value.map(renderXml).filter(Boolean).join("\n");
  if (typeof value !== "object") return escapeXml(String(value));

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
  attrs?: StructuredPromptSection["attrs"],
): StructuredPromptSection {
  return {
    tag,
    content,
    ...(attrs !== undefined ? { attrs } : {}),
  };
}

export function buildStructuredSystemPrompt(
  sections: StructuredPromptSection[],
): string {
  return renderXml(sections.map((s) => xml(s.tag, s.content, s.attrs)));
}

export function bulletList(items: string[]): XmlValue[] {
  return items.map((item) => xml("item", item));
}

export function jsonOutputContract(shape: Record<string, string>): XmlNode {
  const fields = Object.entries(shape).map(([name, description]) =>
    xml("field", description, { name }),
  );
  return xml("output", fields, { format: "json", fences: false });
}

// Every XML tag the structured-prompt builders emit as scaffolding: the section
// tags used by structuredSection across prompts, the bulletList `item` tag, and
// the `output`/`field` tags of the JSON output contract. This is the single
// source of truth so any leak-stripper stays in sync with the builders — adding
// a new structuredSection tag here keeps the stripper aware of it.
export const SCAFFOLDING_TAGS = [
  "role",
  "structure",
  "formatting",
  "voice",
  "hook-style",
  "rules",
  "ruleset",
  "style",
  "context",
  "messaging",
  "output",
  "item",
  "field",
] as const;

export type ScaffoldingTag = (typeof SCAFFOLDING_TAGS)[number];

export const SPECIALIST_MAIL_SECTION: PromptSection = {
  tag: "messaging",
  content: `How to identify who sent the current message:
- The turn begins with a [From: <address>] header.
- Addresses starting with usr_ are human users — reply via chat as normal.
- Addresses starting with ins_ are agent instances that dispatched you — they are waiting for your result.

When dispatched by an agent (ins_ address):
1. Complete your task.
2. Call mail_search with query { "from": "<the ins_ address from the [From:] header>" } to get the message ref.
   - If the results array is empty, send your result via mail_send to the ins_ address instead and stop.
   - If the results array has multiple entries, use the last one (highest UID — most recent message from that sender).
3. Call mail_reply with that ref to send your result. This keeps the reply in the same thread so the dispatcher receives it.
4. Your turn is done. Do not continue the conversation.

Never construct a message ref from scratch — always retrieve it via mail_search first.`,
};

export const LINKEDIN_WRITING_SECTIONS: StructuredPromptSection[] = [
  structuredSection(
    "role",
    "You are writing in first person as a practitioner sharing a field observation with a professional audience. You are not a marketer. You are an operator who noticed something.",
  ),
  structuredSection(
    "structure",
    bulletList([
      "Open with a specific, concrete observation. Never a question. Never excitement filler.",
      "Develop the idea over several short paragraphs: what you saw, why it matters, the pattern behind it.",
      "Land one sharp category insight that reframes a problem many teams face.",
      "Close with a single reflective line. No call to action.",
    ]),
  ),
  structuredSection(
    "formatting",
    bulletList([
      "Paste-ready: clean single blank line between paragraphs.",
      "No hashtags. No emoji.",
      "Sentence case throughout.",
      "No em dashes. No superlatives. No hollow adjectives.",
      "150-250 words. Vary sentence length so it reads like a person talking, not a list of clipped lines.",
    ]),
  ),
  structuredSection(
    "voice",
    bulletList([
      "No buzzwords: no synergy, leverage, unlock, streamline, game-changing, best-in-class.",
      'No engagement bait: no "thoughts?", no manufactured urgency, no questions posed to the reader.',
      "Write how a sharp person talks to a peer, not how a marketing team edits copy.",
    ]),
  ),
];
