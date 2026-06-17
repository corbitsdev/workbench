import { afterEach, describe, expect, it } from 'bun:test';
import { parseSelectionArtifactContent, SELECTION_ARTIFACT_KIND } from '../resource-enrichment';
import {
  buildErrorSelectionDraft,
  buildSeoResponseSeed,
  buildSeoSelectionDraft,
  buildSeoUserMessage,
  enrichSeoRow,
  parseSeoReply,
  validateSeoPayload,
  type SeoPayload,
} from './seo';
import type { SeoResourceRow } from './types';

const fiveOf = (prefix: string): string[] => [1, 2, 3, 4, 5].map((n) => `${prefix}-${n}`);

const validPayload: SeoPayload = {
  sku_id: 'slug',
  seo_titles: fiveOf('t'),
  seo_descriptions: fiveOf('d'),
  product_summaries: fiveOf('s'),
};

const row = {
  productSlug: 'eucalyptus-frame',
  productName: 'Eucalyptus Frame',
  tertiaryCategory: '',
  subCategory: 'Invitations',
  category: 'Invitations',
  styles: ['classic'],
  productSuiteName: 'Eucalyptus',
  productMetadataTitle: '',
  productMetadataDescription: '',
  summary: '',
} as unknown as SeoResourceRow;

describe('validateSeoPayload', () => {
  it('accepts a 5/5/5 payload', () => {
    const result = validateSeoPayload(validPayload);
    expect(result.ok).toBe(true);
  });

  it('rejects a wrong variant count', () => {
    const result = validateSeoPayload({ ...validPayload, seo_titles: ['only-one'] });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.errors.join(' ')).toContain('seo_titles');
  });

  it('rejects empty variants', () => {
    const result = validateSeoPayload({
      ...validPayload,
      product_summaries: ['a', 'b', 'c', 'd', ''],
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseSeoReply', () => {
  it('throws on non-JSON', () => {
    expect(() => parseSeoReply('not json')).toThrow(/JSON/);
  });

  it('throws on a shape violation', () => {
    expect(() => parseSeoReply(JSON.stringify({ sku_id: 'x' }))).toThrow(/5\/5\/5/);
  });

  it('returns the payload for a valid reply', () => {
    expect(parseSeoReply(JSON.stringify(validPayload)).sku_id).toBe('slug');
  });
});

describe('buildSeoSelectionDraft', () => {
  it('maps the payload onto a selection with 5/5/5 fields and no pick', () => {
    const draft = buildSeoSelectionDraft(row, validPayload);
    expect(draft.kind).toBe(SELECTION_ARTIFACT_KIND);
    const content = parseSelectionArtifactContent(draft.content);
    expect(content.fields.Title).toHaveLength(5);
    expect(content.fields.Description).toHaveLength(5);
    expect(content.fields.Summary).toHaveLength(5);
    expect(content.chosen).toBeNull();
  });
});

describe('buildErrorSelectionDraft', () => {
  it('produces a pre-decided error selection that does not block export', () => {
    const draft = buildErrorSelectionDraft(row, 'image fetch failed');
    const content = parseSelectionArtifactContent(draft.content);
    expect(content.fields.Error).toEqual(['image fetch failed']);
    expect(content.chosen).toEqual({ Error: 0 });
  });
});

describe('buildSeoUserMessage', () => {
  it('includes the product metadata and the generate instruction', () => {
    const message = buildSeoUserMessage(row);
    expect(message).toContain('eucalyptus-frame');
    expect(message).toContain('"seo_titles": []');
    expect(message).toContain('exactly 5 non-empty string variants');
  });
});

describe('buildSeoResponseSeed', () => {
  it('anchors the required response shape to the row slug', () => {
    expect(buildSeoResponseSeed(row)).toEqual({
      sku_id: 'eucalyptus-frame',
      seo_titles: [],
      seo_descriptions: [],
      product_summaries: [],
    });
  });
});

describe('enrichSeoRow', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const imageRow = { ...row, imageLink: 'https://example.com/a.png' } as SeoResourceRow;
  const stubImageFetch = () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as unknown as typeof fetch;
  };

  it('returns an error selection when the image cannot be loaded', async () => {
    const draft = await enrichSeoRow({ ...row, imageLink: '' } as SeoResourceRow, async () => '');
    const content = parseSelectionArtifactContent(draft.content);
    expect(content.fields.Error?.[0]).toBe('image unavailable');
  });

  it('returns a 5/5/5 selection when inference succeeds', async () => {
    stubImageFetch();
    const draft = await enrichSeoRow(imageRow, async () => JSON.stringify(validPayload));
    const content = parseSelectionArtifactContent(draft.content);
    expect(content.fields.Title).toHaveLength(5);
    expect(content.chosen).toBeNull();
  });

  it('returns an error selection when inference throws', async () => {
    stubImageFetch();
    const draft = await enrichSeoRow(imageRow, async () => {
      throw new Error('provider exploded with internal model name xyz');
    });
    const content = parseSelectionArtifactContent(draft.content);
    // Categorized, not the raw provider error.
    expect(content.fields.Error?.[0]).toBe('enrichment failed');
  });

  it('returns a "response invalid" selection when the reply fails the 5/5/5 gate', async () => {
    stubImageFetch();
    const draft = await enrichSeoRow(imageRow, async () => JSON.stringify({ sku_id: 'x' }));
    const content = parseSelectionArtifactContent(draft.content);
    expect(content.fields.Error?.[0]).toBe('response invalid');
  });
});
