import { describe, expect, it } from 'bun:test';
import { createPresentationIntakeArtifacts, derivePresentationRunTitle } from './artifacts';

describe('derivePresentationRunTitle', () => {
  it('returns companyName first', () => {
    expect(derivePresentationRunTitle({ companyName: 'Acme', callTitle: 'Call' })).toBe('Acme');
  });

  it('falls back to callTitle', () => {
    expect(derivePresentationRunTitle({ callTitle: 'Discovery Call' })).toBe('Discovery Call');
  });

  it('falls back to artifactTitle', () => {
    expect(derivePresentationRunTitle({ artifactTitle: 'One Pager' })).toBe('One Pager');
  });

  it('returns null when no title data', () => {
    expect(derivePresentationRunTitle({})).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(derivePresentationRunTitle(undefined)).toBeNull();
  });
});

describe('createPresentationIntakeArtifacts', () => {
  it('creates transcript artifact with correct title format for granola', () => {
    const artifacts = createPresentationIntakeArtifacts({
      content: 'transcript text',
      callTitle: 'Discovery',
      transcriptSource: 'granola',
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.title).toBe('Transcript — Discovery');
    expect(artifacts[0]?.kind).toBe('call-transcript');
    expect(artifacts[0]?.status).toBe('approved');
    expect(artifacts[0]?.content).toBe('transcript text');
  });

  it('creates transcript artifact for paste source', () => {
    const artifacts = createPresentationIntakeArtifacts({
      content: 'notes text',
      callTitle: 'Notes',
      transcriptSource: 'paste',
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.kind).toBe('call-transcript');
    expect(artifacts[0]?.status).toBe('approved');
  });

  it('returns empty array for artifact source', () => {
    const artifacts = createPresentationIntakeArtifacts({
      content: '',
      transcriptSource: 'artifact',
    });
    expect(artifacts).toHaveLength(0);
  });

  it('uses "Call" as fallback title when callTitle is absent', () => {
    const artifacts = createPresentationIntakeArtifacts({
      content: 'text',
      transcriptSource: 'paste',
    });
    expect(artifacts[0]?.title).toBe('Transcript — Call');
  });
});
