import { describe, expect, it } from 'bun:test';
import type { SelectionArtifactContent } from '../resource-enrichment';
import { assembleSeoCsv } from './export';
import type { SeoResourceRow } from './types';

const rows = [
  { productSlug: 'a', imageLink: 'https://example.com/a.jpg' },
  { productSlug: 'b', imageLink: 'https://example.com/b.jpg' },
] as unknown as SeoResourceRow[];

const selA: SelectionArtifactContent = {
  label: 'a',
  fields: { Title: ['t0', 't1'], Description: ['d0', 'd1'], Summary: ['s0', 's1'] },
  chosen: { Title: 1, Description: 0, Summary: 1 },
};
const selB: SelectionArtifactContent = {
  label: 'b',
  fields: { Title: ['x0'], Description: ['y0'], Summary: ['z0'] },
  chosen: null,
};

describe('assembleSeoCsv', () => {
  it('emits the SEO columns with chosen copy joined to image_link', () => {
    const csv = assembleSeoCsv(rows, [selA], '2026-06-15T00:00:00.000Z');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(
      'product_slug,image_link,chosen_title,chosen_description,chosen_summary,timestamp'
    );
    expect(lines[1]).toBe('a,https://example.com/a.jpg,t1,d0,s1,2026-06-15T00:00:00.000Z');
  });

  it('excludes selections without a pick', () => {
    const csv = assembleSeoCsv(rows, [selA, selB], 'ts');
    expect(csv.trim().split('\n')).toHaveLength(2);
  });

  it('leaves image_link empty when the slug has no parsed row', () => {
    const csv = assembleSeoCsv([], [selA], 'ts');
    expect(csv.trim().split('\n')[1]).toBe('a,,t1,d0,s1,ts');
  });

  it('neutralizes a formula-leading chosen value (CSV injection)', () => {
    const sel: SelectionArtifactContent = {
      label: 'r',
      fields: { Title: ['=SUM(A1:A9)'], Description: ['ok'], Summary: ['ok'] },
      chosen: { Title: 0, Description: 0, Summary: 0 },
    };
    const csv = assembleSeoCsv([], [sel], 'ts');
    expect(csv).toContain("'=SUM(A1:A9)");
  });
});
