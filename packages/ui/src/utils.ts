import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const TOOL_PREFIXES = ['granola_', 'firecrawl_', 'exa_'];
// Words whose canonical casing is not plain Title Case.
const ACRONYMS: Record<string, string> = {
  linkedin: 'LinkedIn',
  pov: 'POV',
  seo: 'SEO',
  api: 'API',
  url: 'URL',
  csv: 'CSV',
  ai: 'AI',
  id: 'ID',
  ui: 'UI',
  ux: 'UX',
  mcp: 'MCP',
};

export function toHumanLabel(name: string): string {
  if (name === '') return '';
  let cleaned = name;
  for (const prefix of TOOL_PREFIXES) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length);
      break;
    }
  }
  return cleaned
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map((word) => {
      if (word === '') return word;
      const lower = word.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}
