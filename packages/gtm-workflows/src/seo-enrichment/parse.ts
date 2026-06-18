import ExcelJS from 'exceljs';
import { type } from 'arktype';
import {
  SeoResourceRow,
  type SeoIngestResult,
  type RejectedRow,
  type SuiteAttributes,
} from './types';

const SHEET_NAME = 'Sheet1';

// Sheet1 header -> top-level SeoResourceRow field.
const COLUMN_FIELDS: Record<string, keyof SeoResourceRow> = {
  'Image Link': 'imageLink',
  PRODUCT_SUITE_NAME: 'productSuiteName',
  PRODUCT_SUITE_SLUG: 'productSuiteSlug',
  PRODUCT_SLUG: 'productSlug',
  PRODUCT_NAME: 'productName',
  PRODUCT_METADATA_TITLE: 'productMetadataTitle',
  PRODUCT_METADATA_DESCRIPTION: 'productMetadataDescription',
  SUMMARY: 'summary',
  Category: 'category',
  'Sub Category': 'subCategory',
  'Tertiary Category': 'tertiaryCategory',
};

// Sheet1 header -> nested suite attribute field.
const SUITE_COLUMN_FIELDS: Record<string, keyof SuiteAttributes> = {
  PRODUCT_SUITE_DESIGN_STYLE: 'designStyle',
  PRODUCT_SUITE_TYPE_ONLY: 'typeOnly',
  PRODUCT_SUITE_DESTINATION: 'destination',
  PRODUCT_SUITE_CULTURAL: 'cultural',
  PRODUCT_SUITE_RELIGIOUS: 'religious',
  PRODUCT_SUITE_FLORAL: 'floral',
  PRODUCT_SUITE_LOCATION: 'location',
  PRODUCT_SUITE_TYPOGRAPHY: 'typography',
  PRODUCT_SUITE_TEXT_FORMAT: 'textFormat',
  PRODUCT_SUITE_ARTWORK_FORMAT: 'artworkFormat',
  PRODUCT_SUITE_ILLUSTRATION_TYPE: 'illustrationType',
  PRODUCT_SUITE_DESIGN_ELEMENT: 'designElement',
  PRODUCT_SUITE_HOLIDAY: 'holiday',
  PRODUCT_SUITE_FOIL: 'foil',
};

const EMPTY_SUITE: SuiteAttributes = {
  designStyle: '',
  typeOnly: '',
  destination: '',
  cultural: '',
  religious: '',
  floral: '',
  location: '',
  typography: '',
  textFormat: '',
  artworkFormat: '',
  illustrationType: '',
  designElement: '',
  holiday: '',
  foil: '',
};

// exceljs cell values are a union of primitives and rich objects (hyperlink,
// formula, rich text). Flatten to the plain text the catalog author entered.
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // A hyperlink cell carries both `hyperlink` (the target) and `text` (the
    // display label); the target is the meaningful value, especially for the
    // Image Link column, so it wins over the label.
    if ('hyperlink' in value && typeof value.hyperlink === 'string') {
      return value.hyperlink.trim();
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text.trim();
    }
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((part) => part.text)
        .join('')
        .trim();
    }
  }
  return '';
}

function parseStyles(raw: string): string[] {
  if (raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `STYLES is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === 'string')) {
    throw new Error('STYLES is not a JSON array of strings');
  }
  return parsed;
}

function parseNumPhotos(raw: string): number {
  if (raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`PRODUCT_NUM_PHOTOS is not a number: "${raw}"`);
  }
  return n;
}

function readHeaderIndex(sheet: ExcelJS.Worksheet): Map<string, number> {
  const headerRow = sheet.getRow(1);
  const index = new Map<string, number>();
  headerRow.eachCell((cell, colNumber) => {
    const header = cellText(cell.value);
    if (header !== '') index.set(header, colNumber);
  });
  return index;
}

// Parse a product workbook's Sheet1 into typed, validated rows. The workbook
// arrives as a Buffer (the upload is stored as BYTEA, not a file path).
// Malformed rows are flagged with a clear reason rather than aborting the batch;
// a structurally wrong file (missing sheet or required columns) throws, since
// the boundary contract is broken.
export async function parseSeoResourceWorkbook(data: Buffer): Promise<SeoIngestResult> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS 4.4 types predate TS5.9's Buffer<T> generics — the types diverge but runtime is compatible.
  // @ts-expect-error
  await workbook.xlsx.load(data);

  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    throw new Error(`workbook has no sheet named "${SHEET_NAME}"`);
  }

  const headers = readHeaderIndex(sheet);
  const required = [...Object.keys(COLUMN_FIELDS), 'STYLES', 'PRODUCT_NUM_PHOTOS'];
  const missing = required.filter((h) => !headers.has(h));
  if (missing.length > 0) {
    throw new Error(`Sheet1 is missing required columns: ${missing.join(', ')}`);
  }

  const rows: SeoResourceRow[] = [];
  const rejected: RejectedRow[] = [];

  const lastRow = sheet.rowCount;
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const get = (header: string): string => {
      const col = headers.get(header);
      return col === undefined ? '' : cellText(row.getCell(col).value);
    };

    if (required.every((h) => get(h) === '')) {
      continue; // fully blank trailing row
    }

    try {
      const suite: SuiteAttributes = { ...EMPTY_SUITE };
      for (const [header, field] of Object.entries(SUITE_COLUMN_FIELDS)) {
        suite[field] = get(header);
      }

      const candidate = {
        imageLink: get('Image Link'),
        productSuiteName: get('PRODUCT_SUITE_NAME'),
        productSuiteSlug: get('PRODUCT_SUITE_SLUG'),
        styles: parseStyles(get('STYLES')),
        productSlug: get('PRODUCT_SLUG'),
        productName: get('PRODUCT_NAME'),
        productMetadataTitle: get('PRODUCT_METADATA_TITLE'),
        productMetadataDescription: get('PRODUCT_METADATA_DESCRIPTION'),
        summary: get('SUMMARY'),
        category: get('Category'),
        subCategory: get('Sub Category'),
        tertiaryCategory: get('Tertiary Category'),
        productNumPhotos: parseNumPhotos(get('PRODUCT_NUM_PHOTOS')),
        suite,
      };

      const validated = SeoResourceRow(candidate);
      if (validated instanceof type.errors) {
        rejected.push({ rowNumber, reason: validated.summary });
        continue;
      }
      rows.push(validated);
    } catch (err) {
      rejected.push({
        rowNumber,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { rows, rejected };
}
