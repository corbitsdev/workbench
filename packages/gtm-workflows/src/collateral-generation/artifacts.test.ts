import { describe, expect, it } from 'bun:test';
import {
  appendVariantSuffix,
  collateralTypeOptions,
  createPainPointArtifacts,
  createTranscriptArtifacts,
  deriveCollateralRunTitle,
  formatPainPointsDocument,
  getVariantCount,
  hasMultiVariantKind,
  isCollateralKind,
  resolveArtifactKind,
  selectCollateralTypeIds,
  type CollateralPainPoint,
} from './artifacts';

describe('collateralTypeOptions', () => {
  it('includes linkedin-daily', () => {
    expect(collateralTypeOptions.map((o) => o.id)).toContain('linkedin-daily');
  });
});

describe('getVariantCount', () => {
  it('returns 3 for linkedin-daily', () => {
    expect(getVariantCount('linkedin-daily')).toBe(3);
  });

  it('returns 1 for all other collateral kinds', () => {
    for (const option of collateralTypeOptions) {
      if (option.id === 'linkedin-daily') continue;
      expect(getVariantCount(option.id)).toBe(1);
    }
  });

  it('returns 1 for unknown kinds', () => {
    expect(getVariantCount('unknown-kind')).toBe(1);
  });
});

describe('appendVariantSuffix', () => {
  it('appends Draft N to the title for multi-variant kinds', () => {
    const result = appendVariantSuffix(
      { title: 'Hook play', body: 'content' },
      'linkedin-daily',
      0
    );
    expect(result.title).toBe('Hook play — Draft 1');
    expect(result.body).toBe('content');
  });

  it('increments draft number by variantIndex', () => {
    expect(appendVariantSuffix({ title: 'T', body: '' }, 'linkedin-daily', 2).title).toBe(
      'T — Draft 3'
    );
  });

  it('passes through unchanged for single-variant kinds', () => {
    const collateral = { title: 'Post', body: 'body' };
    expect(appendVariantSuffix(collateral, 'linkedin-post', 0)).toBe(collateral);
    expect(appendVariantSuffix(collateral, 'blog', 1)).toBe(collateral);
  });
});

describe('hasMultiVariantKind', () => {
  it('returns true when any artifact is a multi-variant kind', () => {
    expect(hasMultiVariantKind([{ kind: 'linkedin-daily' }, { kind: 'email' }])).toBe(true);
  });

  it('returns false when no artifact is a multi-variant kind', () => {
    expect(hasMultiVariantKind([{ kind: 'email' }, { kind: 'blog' }])).toBe(false);
  });

  it('returns false for an empty list', () => {
    expect(hasMultiVariantKind([])).toBe(false);
  });
});

describe('isCollateralKind', () => {
  it('treats bookkeeping kinds as non-collateral', () => {
    expect(isCollateralKind('call-transcript')).toBe(false);
    expect(isCollateralKind('pain-points')).toBe(false);
  });

  it('treats every other kind as collateral', () => {
    expect(isCollateralKind('linkedin-post')).toBe(true);
    expect(isCollateralKind('blog')).toBe(true);
  });
});

describe('resolveArtifactKind', () => {
  it('maps the linkedin-daily selection kind to the linkedin-post artifact kind', () => {
    expect(resolveArtifactKind('linkedin-daily')).toBe('linkedin-post');
  });

  it('leaves linkedin-post unchanged', () => {
    expect(resolveArtifactKind('linkedin-post')).toBe('linkedin-post');
  });

  it('returns an unmapped kind unchanged', () => {
    expect(resolveArtifactKind('battlecard')).toBe('battlecard');
  });

  it('passes a truly-unknown selection through unchanged', () => {
    expect(resolveArtifactKind('totally-unknown')).toBe('totally-unknown');
  });
});

describe('selectCollateralTypeIds', () => {
  it('keeps only ids in the allowed option set', () => {
    expect(selectCollateralTypeIds(['linkedin-post', 'made-up', 'blog'])).toEqual([
      'linkedin-post',
      'blog',
    ]);
  });

  it('returns an empty list when nothing is requested', () => {
    expect(selectCollateralTypeIds(undefined)).toEqual([]);
  });
});

describe('deriveCollateralRunTitle', () => {
  it('prefers a trimmed company name', () => {
    expect(deriveCollateralRunTitle({ companyName: '  Acme  ', callTitle: 'Q3 sync' })).toBe(
      'Acme'
    );
  });

  it('falls back to the call title when company name is blank', () => {
    expect(deriveCollateralRunTitle({ companyName: '   ', callTitle: '  Q3 sync ' })).toBe(
      'Q3 sync'
    );
  });

  it('returns null when neither is present', () => {
    expect(deriveCollateralRunTitle(undefined)).toBeNull();
    expect(deriveCollateralRunTitle({ companyName: 42 })).toBeNull();
  });
});

describe('createTranscriptArtifacts', () => {
  it('produces an approved transcript artifact with the call title', () => {
    const [artifact] = createTranscriptArtifacts({ content: 'hello', callTitle: '  Demo  ' });
    expect(artifact).toMatchObject({ kind: 'call-transcript', status: 'approved', version: 1 });
    expect(artifact?.title).toBe('Transcript — Demo');
    expect(artifact?.content).toBe('hello');
  });

  it('defaults the title when no call title is given', () => {
    const [artifact] = createTranscriptArtifacts({ content: 'x' });
    expect(artifact?.title).toBe('Transcript — Call');
  });
});

describe('formatPainPointsDocument', () => {
  it('returns a placeholder when there are no points', () => {
    expect(formatPainPointsDocument([])).toBe('No pain points extracted.');
  });

  it('renders each point with severity and quote', () => {
    const points: CollateralPainPoint[] = [
      { severity: 'high', context: 'Onboarding', quote: 'too slow' },
    ];
    const doc = formatPainPointsDocument(points);
    expect(doc).toMatch(/## 1\. Onboarding/);
    expect(doc).toMatch(/Severity: high/);
    expect(doc).toMatch(/Quote: "too slow"/);
  });
});

describe('createPainPointArtifacts', () => {
  it('titles by company name when present', () => {
    const [artifact] = createPainPointArtifacts({ points: [], companyName: 'Acme' });
    expect(artifact?.title).toBe('Pain Points — Acme');
    expect(artifact).toMatchObject({ kind: 'pain-points', status: 'approved' });
  });

  it('falls back to run title then to Call', () => {
    expect(createPainPointArtifacts({ points: [], runTitle: 'Q3' })[0]?.title).toBe(
      'Pain Points — Q3'
    );
    expect(createPainPointArtifacts({ points: [] })[0]?.title).toBe('Pain Points — Call');
  });
});
