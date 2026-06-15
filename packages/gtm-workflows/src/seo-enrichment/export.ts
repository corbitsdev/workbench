import type { SelectionArtifactContent } from '../resource-enrichment';
import type { SeoResourceRow } from './types';

// The SEO export columns (CL-1973): the chosen copy per row plus its slug, image
// link, and a run timestamp. One row per decided selection.
const HEADER = [
  'product_slug',
  'image_link',
  'chosen_title',
  'chosen_description',
  'chosen_summary',
  'timestamp',
] as const;

// The chosen copy is LLM-generated, so a cell may begin with =, +, -, @ (or a
// control char) — the CSV-injection vector when opened in a spreadsheet. Prefix
// a single quote to neutralize formula evaluation. This is the product's output
// format (a CSV the user opens in Excel/Sheets), so the guard is load-bearing.
function neutralizeFormula(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

// RFC 4180: quote fields containing a comma, quote or newline; double embedded quotes.
function escapeCsv(value: string): string {
  const safe = neutralizeFormula(value);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

// Assemble the SEO CSV from the chosen selections, joining image_link from the
// parsed rows by product slug (the selection label). Selections without a pick
// are excluded; the caller passes only decided ones (or they are skipped here).
export function assembleSeoCsv(
  rows: SeoResourceRow[],
  selections: SelectionArtifactContent[],
  timestamp: string
): string {
  const imageBySlug = new Map(rows.map((row) => [row.productSlug, row.imageLink]));
  const lines = [HEADER.join(',')];

  for (const selection of selections) {
    if (selection.chosen === null) continue;
    const chosen = selection.chosen;
    const pick = (field: string): string => {
      const index = chosen[field];
      if (index === undefined) return '';
      return selection.fields[field]?.[index] ?? '';
    };
    const cells = [
      selection.label,
      imageBySlug.get(selection.label) ?? '',
      pick('Title'),
      pick('Description'),
      pick('Summary'),
      timestamp,
    ];
    lines.push(cells.map(escapeCsv).join(','));
  }

  return `${lines.join('\n')}\n`;
}
