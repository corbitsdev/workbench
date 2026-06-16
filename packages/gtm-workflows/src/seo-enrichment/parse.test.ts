import { describe, expect, it } from 'bun:test';
import ExcelJS from 'exceljs';
import { parseSeoResourceWorkbook } from './parse';

const HEADERS = [
  'Image Link',
  'PRODUCT_SUITE_NAME',
  'PRODUCT_SUITE_SLUG',
  'PRODUCT_SLUG',
  'PRODUCT_NAME',
  'PRODUCT_METADATA_TITLE',
  'PRODUCT_METADATA_DESCRIPTION',
  'SUMMARY',
  'Category',
  'Sub Category',
  'Tertiary Category',
  'STYLES',
  'PRODUCT_NUM_PHOTOS',
];

function validRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'Image Link': 'https://example.com/a.jpg',
    PRODUCT_SUITE_NAME: 'Eucalyptus Frame',
    PRODUCT_SUITE_SLUG: 'eucalyptus-frame',
    PRODUCT_SLUG: 'eucalyptus-frame-invitation',
    PRODUCT_NAME: 'Eucalyptus Frame Invitation',
    PRODUCT_METADATA_TITLE: 'Title',
    PRODUCT_METADATA_DESCRIPTION: 'Desc',
    SUMMARY: 'Summary',
    Category: 'Invitations',
    'Sub Category': 'Wedding',
    'Tertiary Category': '',
    STYLES: '["classic"]',
    PRODUCT_NUM_PHOTOS: '3',
    ...overrides,
  };
}

async function buildWorkbook(rows: Array<Record<string, string>>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(HEADERS);
  for (const row of rows) {
    sheet.addRow(HEADERS.map((h) => row[h] ?? ''));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('parseSeoResourceWorkbook', () => {
  it('parses valid rows into typed SeoResourceRow objects', async () => {
    const buffer = await buildWorkbook([validRow()]);
    const result = await parseSeoResourceWorkbook(buffer);
    expect(result.rejected).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.productSlug).toBe('eucalyptus-frame-invitation');
    expect(result.rows[0]?.styles).toEqual(['classic']);
    expect(result.rows[0]?.productNumPhotos).toBe(3);
  });

  it('flags malformed rows without aborting the batch', async () => {
    const buffer = await buildWorkbook([validRow({ PRODUCT_NAME: '' }), validRow()]);
    const result = await parseSeoResourceWorkbook(buffer);
    expect(result.rows).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.rowNumber).toBe(2);
  });

  it('flags a row whose STYLES is not a JSON array', async () => {
    const buffer = await buildWorkbook([validRow({ STYLES: 'not-json' })]);
    const result = await parseSeoResourceWorkbook(buffer);
    expect(result.rows).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain('STYLES');
  });

  it('returns no rows for a header-only (empty) sheet', async () => {
    const buffer = await buildWorkbook([]);
    const result = await parseSeoResourceWorkbook(buffer);
    expect(result.rows).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it('throws when Sheet1 is absent', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Other');
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseSeoResourceWorkbook(buffer)).rejects.toThrow(/Sheet1/);
  });
});
