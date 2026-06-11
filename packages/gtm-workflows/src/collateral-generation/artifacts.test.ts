import { describe, expect, it } from 'bun:test';
import {
  createPainPointArtifacts,
  createTranscriptArtifacts,
  deriveCollateralRunTitle,
  formatPainPointsDocument,
  isCollateralKind,
  selectCollateralTypeIds,
  type CollateralPainPoint,
} from './artifacts';

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
