import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import ExcelJS from 'exceljs';
import * as realInference from '../lib/inference';
import { setSelectionChosen } from '@workbench/gtm-workflows';
import type { HubDb } from '../db';

// Mock only the credential-backed multimodal inference call — everything else
// (xlsx parse, image fetch, prompt assembly, CSV assembly) runs for real.
const SEO_PAYLOAD = {
  sku_id: 'sku',
  seo_titles: ['T0', 'T1', 'T2', 'T3', 'T4'],
  seo_descriptions: ['D0', 'D1', 'D2', 'D3', 'D4'],
  product_summaries: ['S0', 'S1', 'S2', 'S3', 'S4'],
};
mock.module('../lib/inference', () => ({
  ...realInference,
  runSingleTurnAgentWithImage: mock(async () => JSON.stringify(SEO_PAYLOAD)),
}));

import {
  createResourceEnrichmentRun,
  runResourceEnrichmentEnrich,
  runResourceEnrichmentExport,
} from './resource-enrichment';

const USER = { tenantId: 'tenant-global', principalId: 'prn-1' };
const FAKE_SOURCE = { provider: 'openai', model: 'gpt-4o' } as never;
const ROW_COUNT = 10;

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

async function tenRowWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(HEADERS);
  for (let i = 0; i < ROW_COUNT; i++) {
    sheet.addRow([
      `https://example.com/${i}.jpg`,
      'Eucalyptus',
      'eucalyptus',
      `slug-${i}`,
      `Product ${i}`,
      'Title',
      'Desc',
      'Summary',
      'Invitations',
      'Wedding',
      '',
      '["classic"]',
      '1',
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// A stateful in-memory DB: insert accumulates artifacts; queries read them back.
function createStatefulDb(uploadContent: Buffer) {
  const artifacts: Array<Record<string, unknown> & { id: string }> = [];
  const db = {
    query: {
      upload: {
        findFirst: async () => ({
          id: 'upl-1',
          tenantId: 'tenant-global',
          filename: 'catalog.xlsx',
          content: uploadContent,
        }),
      },
      artifact: {
        findMany: async () => artifacts.filter((a) => a.kind === 'selection'),
        findFirst: async () => artifacts.find((a) => a.kind === 'parsed-resource') ?? null,
      },
    },
    insert: () => ({ values: () => ({ returning: () => [{ id: 'wf-1' }] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        insert: () => ({
          values: (vals: Record<string, unknown>) => {
            if ('kind' in vals) {
              const id = `art-${artifacts.length}`;
              artifacts.push({ id, ...vals });
              return { returning: () => [{ id }] };
            }
            return Promise.resolve();
          },
        }),
      }),
  } as unknown as HubDb;
  return { db, artifacts };
}

// Stub the image fetch so the real loadProductImage succeeds without network.
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('seo-enrichment end to end (real parse + CSV, mocked inference)', () => {
  it('runs upload → parse → enrich → pick → export → download for 10 rows', async () => {
    const { db, artifacts } = createStatefulDb(await tenRowWorkbook());

    const run = await createResourceEnrichmentRun(db, USER, 'seo-enrichment', 'upl-1');
    expect(run.status).toBe('running');
    expect(artifacts.filter((a) => a.kind === 'parsed-resource')).toHaveLength(1);

    const enrich = await runResourceEnrichmentEnrich(db, 'wf-1', USER, FAKE_SOURCE);
    expect(enrich.selections).toBe(ROW_COUNT);
    const selections = artifacts.filter((a) => a.kind === 'selection');
    expect(selections).toHaveLength(ROW_COUNT);

    // Reviewer picks the first option of each field for every row (simulates the
    // PATCH /selection writes by mutating stored content in place).
    for (const selection of selections) {
      selection.content = setSelectionChosen(selection.content as string, {
        Title: 0,
        Description: 0,
        Summary: 0,
      });
    }

    const exportResult = await runResourceEnrichmentExport(
      db,
      'wf-1',
      USER,
      '2026-06-15T00:00:00.000Z'
    );
    expect(exportResult.status).toBe('done');

    const csvArtifact = artifacts.find((a) => a.kind === 'csv-export');
    if (!csvArtifact) throw new Error('csv-export not created');
    const lines = (csvArtifact.content as string).trim().split('\n');
    expect(lines[0]).toBe(
      'product_slug,image_link,chosen_title,chosen_description,chosen_summary,timestamp'
    );
    expect(lines).toHaveLength(ROW_COUNT + 1);
    expect(lines[1]).toBe('slug-0,https://example.com/0.jpg,T0,D0,S0,2026-06-15T00:00:00.000Z');
    expect(lines[ROW_COUNT]).toContain('slug-9,https://example.com/9.jpg,T0,D0,S0');
  });
});
