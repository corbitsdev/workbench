export interface PromptSection {
  tag: string;
  content: string;
}

export type PromptFormat = 'xml' | 'markdown';

// Derive format from a model string (caller convenience)
export function formatFromModel(model: string): PromptFormat {
  return model.startsWith('claude') ? 'xml' : 'markdown';
}

export function formatSection(section: PromptSection, format: PromptFormat): string {
  if (format === 'xml') {
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
