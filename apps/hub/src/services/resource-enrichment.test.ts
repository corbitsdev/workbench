import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import ExcelJS from 'exceljs';
import { buildSelectionArtifactContent } from '@workbench/gtm-workflows';
import * as realInference from '../lib/inference';
import type { HubDb } from '../db';

// Mock only the credential-backed inference call (a hub module). The package
// surface (@workbench/gtm-workflows) is used for real — module-mocking it leaks
// process-wide under bun and breaks the e2e test.
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
  isResourceEnrichmentKind,
  ResourceEnrichmentError,
  runResourceEnrichmentEnrich,
  runResourceEnrichmentExport,
} from './resource-enrichment';

const USER = { tenantId: 'tenant-global', principalId: 'prn-1' };
const FAKE_SOURCE = { provider: 'openai', model: 'gpt-4o' } as never;

// A full, schema-valid SeoResourceRow — readParsedRows now validates with
// ArkType, so the parsed-resource fixtures must be complete rows.
function fullRow(slug: string, imageLink = `https://example.com/${slug}.jpg`) {
  const suite = {
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
  return {
    imageLink,
    productSuiteName: 'Suite',
    productSuiteSlug: 'suite',
    styles: [],
    productSlug: slug,
    productName: `Product ${slug}`,
    productMetadataTitle: '',
    productMetadataDescription: '',
    summary: '',
    category: 'Invitations',
    subCategory: '',
    tertiaryCategory: '',
    productNumPhotos: 1,
    suite,
  };
}

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

async function workbookBuffer(rowCount: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(HEADERS);
  for (let i = 0; i < rowCount; i++) {
    sheet.addRow([
      `https://example.com/${i}.jpg`,
      'Suite',
      'suite',
      `slug-${i}`,
      `Product ${i}`,
      'Title',
      'Desc',
      'Summary',
      'Invitations',
      'Wedding',
      '',
      '[]',
      '1',
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
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

interface InsertedArtifact {
  kind: string;
  title: string;
  content: string;
  status: string;
}

function createMockDb(options: {
  upload?: { id: string; tenantId: string; filename: string; content?: Buffer } | null;
  selections?: Array<{ content: string }>;
  parsedArtifact?: { content: string } | null;
  onArtifact?: (a: InsertedArtifact) => void;
  onStatus?: (status: string) => void;
}) {
  let counter = 0;
  return {
    query: {
      upload: { findFirst: mock(() => options.upload) },
      artifact: {
        findMany: mock(() => options.selections ?? []),
        findFirst: mock(() => options.parsedArtifact ?? null),
      },
    },
    insert: mock(() => ({
      values: mock(() => ({ returning: mock(() => [{ id: 'wf-1' }]) })),
    })),
    update: mock(() => ({
      set: mock((values: { status: string }) => {
        options.onStatus?.(values.status);
        return { where: mock(() => Promise.resolve()) };
      }),
    })),
    transaction: mock((fn: (tx: unknown) => unknown) =>
      fn({
        insert: mock(() => ({
          values: mock((vals: Record<string, unknown>) => {
            if ('kind' in vals) {
              counter += 1;
              const id = `art-${counter}`;
              options.onArtifact?.(vals as unknown as InsertedArtifact);
              return { returning: mock(() => [{ id }]) };
            }
            return Promise.resolve();
          }),
        })),
      })
    ),
  } as unknown as HubDb;
}

describe('isResourceEnrichmentKind', () => {
  it('matches seo-enrichment and rejects collateral', () => {
    expect(isResourceEnrichmentKind('seo-enrichment')).toBe(true);
    expect(isResourceEnrichmentKind('collateral-generation')).toBe(false);
  });
});

describe('createResourceEnrichmentRun', () => {
  it('parses the upload into a parsed-resource artifact and lands in running', async () => {
    const artifacts: InsertedArtifact[] = [];
    let finalStatus: string | undefined;
    const db = createMockDb({
      upload: {
        id: 'upl-1',
        tenantId: 'tenant-global',
        filename: 'catalog.xlsx',
        content: await workbookBuffer(3),
      },
      onArtifact: (a) => artifacts.push(a),
      onStatus: (s) => (finalStatus = s),
    });

    const run = await createResourceEnrichmentRun(db, USER, 'seo-enrichment', 'upl-1');

    expect(run.status).toBe('running');
    expect(finalStatus).toBe('running');
    expect(artifacts.filter((a) => a.kind === 'parsed-resource')).toHaveLength(1);
    expect(artifacts.filter((a) => a.kind === 'selection')).toHaveLength(0);
  });

  it('rejects a missing upload', async () => {
    const db = createMockDb({ upload: null });
    await expect(createResourceEnrichmentRun(db, USER, 'seo-enrichment', 'nope')).rejects.toThrow(
      ResourceEnrichmentError
    );
  });

  it('rejects an upload owned by another tenant', async () => {
    const db = createMockDb({
      upload: {
        id: 'upl-1',
        tenantId: 'other-tenant',
        filename: 'x.xlsx',
        content: await workbookBuffer(1),
      },
    });
    await expect(createResourceEnrichmentRun(db, USER, 'seo-enrichment', 'upl-1')).rejects.toThrow(
      ResourceEnrichmentError
    );
  });

  it('rejects a file with more than the row cap', async () => {
    const db = createMockDb({
      upload: {
        id: 'upl-1',
        tenantId: 'tenant-global',
        filename: 'big.xlsx',
        content: await workbookBuffer(501),
      },
    });
    await expect(createResourceEnrichmentRun(db, USER, 'seo-enrichment', 'upl-1')).rejects.toThrow(
      /maximum is 500/
    );
  });
});

describe('runResourceEnrichmentEnrich', () => {
  it('fans out over parsed rows, persists a selection each, and lands in reviewing', async () => {
    const artifacts: InsertedArtifact[] = [];
    let finalStatus: string | undefined;
    const db = createMockDb({
      parsedArtifact: {
        content: JSON.stringify({ rows: [fullRow('a'), fullRow('b')], rejected: [] }),
      },
      onArtifact: (a) => artifacts.push(a),
      onStatus: (s) => (finalStatus = s),
    });

    const result = await runResourceEnrichmentEnrich(db, 'wf-1', USER, FAKE_SOURCE);

    expect(result).toEqual({ status: 'reviewing', selections: 2 });
    expect(finalStatus).toBe('reviewing');
    expect(artifacts.filter((a) => a.kind === 'selection')).toHaveLength(2);
  });

  it('rejects when there is no parsed-resource artifact', async () => {
    const db = createMockDb({ parsedArtifact: null });
    await expect(runResourceEnrichmentEnrich(db, 'wf-1', USER, FAKE_SOURCE)).rejects.toThrow(
      ResourceEnrichmentError
    );
  });

  it('drops invalid parsed rows and enriches only the valid ones', async () => {
    const artifacts: InsertedArtifact[] = [];
    const db = createMockDb({
      parsedArtifact: {
        content: JSON.stringify({
          rows: [fullRow('good'), { productSlug: 'bad-incomplete' }],
          rejected: [],
        }),
      },
      onArtifact: (a) => artifacts.push(a),
    });
    const result = await runResourceEnrichmentEnrich(db, 'wf-1', USER, FAKE_SOURCE);
    expect(result.selections).toBe(1);
    expect(artifacts.filter((a) => a.kind === 'selection')).toHaveLength(1);
  });

  it('fans out across batches for more than the concurrency width', async () => {
    const artifacts: InsertedArtifact[] = [];
    const rows = Array.from({ length: 20 }, (_, i) => fullRow(`r${i}`));
    const db = createMockDb({
      parsedArtifact: { content: JSON.stringify({ rows, rejected: [] }) },
      onArtifact: (a) => artifacts.push(a),
    });
    const result = await runResourceEnrichmentEnrich(db, 'wf-1', USER, FAKE_SOURCE);
    expect(result.selections).toBe(20);
  });
});

describe('runResourceEnrichmentExport', () => {
  it('assembles a csv-export with SEO columns and marks the run done', async () => {
    const artifacts: InsertedArtifact[] = [];
    let finalStatus: string | undefined;
    const chosen = buildSelectionArtifactContent({
      label: 'row-1',
      fields: { Title: ['a', 'b'], Description: ['da', 'db'], Summary: ['sa', 'sb'] },
      chosen: { Title: 1, Description: 0, Summary: 1 },
    });
    const unpicked = buildSelectionArtifactContent({
      label: 'row-2',
      fields: { Title: ['c', 'd'] },
      chosen: null,
    });
    const db = createMockDb({
      selections: [{ content: chosen }, { content: unpicked }],
      parsedArtifact: {
        content: JSON.stringify({
          rows: [fullRow('row-1', 'https://example.com/1.jpg')],
          rejected: [],
        }),
      },
      onArtifact: (a) => artifacts.push(a),
      onStatus: (s) => (finalStatus = s),
    });

    const result = await runResourceEnrichmentExport(db, 'wf-1', USER, '2026-06-15T00:00:00.000Z');

    expect(result.status).toBe('done');
    expect(finalStatus).toBe('done');
    const csv = artifacts.find((a) => a.kind === 'csv-export');
    if (!csv) throw new Error('csv-export not created');
    expect(csv.content).toContain(
      'product_slug,image_link,chosen_title,chosen_description,chosen_summary,timestamp'
    );
    expect(csv.content).toContain(
      'row-1,https://example.com/1.jpg,b,da,sb,2026-06-15T00:00:00.000Z'
    );
    expect(csv.content).not.toContain('row-2');
  });

  it('refuses to export when nothing has been chosen', async () => {
    const unpicked = buildSelectionArtifactContent({
      label: 'row-1',
      fields: { Title: ['a', 'b'] },
      chosen: null,
    });
    const db = createMockDb({ selections: [{ content: unpicked }] });
    await expect(runResourceEnrichmentExport(db, 'wf-1', USER)).rejects.toThrow(
      ResourceEnrichmentError
    );
  });
});
