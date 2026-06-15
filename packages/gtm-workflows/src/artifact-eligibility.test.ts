import { describe, expect, it } from 'bun:test';
import {
  canUseArtifactInWorkflow,
  sourceArtifactKindSkipsAnalysis,
  workflowsAcceptingArtifactKind,
  workflowAcceptsArtifactKind,
} from './artifact-eligibility';

describe('workflowAcceptsArtifactKind', () => {
  it('collateral-generation accepts only its specific source kinds', () => {
    expect(workflowAcceptsArtifactKind('collateral-generation', 'call-transcript')).toBe(true);
    expect(workflowAcceptsArtifactKind('collateral-generation', 'pain-points')).toBe(true);
    expect(workflowAcceptsArtifactKind('collateral-generation', 'email')).toBe(false);
  });

  it('presentation-generation accepts any artifact kind (general source)', () => {
    expect(workflowAcceptsArtifactKind('presentation-generation', 'email')).toBe(true);
    expect(workflowAcceptsArtifactKind('presentation-generation', 'pain-points')).toBe(true);
    expect(workflowAcceptsArtifactKind('presentation-generation', 'battlecard')).toBe(true);
  });

  it('rejects unknown workflow kinds', () => {
    expect(workflowAcceptsArtifactKind('nonexistent', 'call-transcript')).toBe(false);
  });
});

describe('workflowsAcceptingArtifactKind', () => {
  it('returns both workflows for a kind collateral accepts', () => {
    const kinds = workflowsAcceptingArtifactKind('pain-points');
    expect(kinds).toContain('collateral-generation');
    expect(kinds).toContain('presentation-generation');
  });

  it('returns only the general workflow for a kind collateral rejects', () => {
    const kinds = workflowsAcceptingArtifactKind('email');
    expect(kinds).toEqual(['presentation-generation']);
  });
});

describe('canUseArtifactInWorkflow', () => {
  it('is true for every artifact kind because a general workflow accepts all', () => {
    for (const kind of ['email', 'linkedin-post', 'battlecard', 'pain-points', 'call-transcript']) {
      expect(canUseArtifactInWorkflow(kind)).toBe(true);
    }
  });

  it('treats an unknown kind as usable because the general workflow accepts it', () => {
    expect(canUseArtifactInWorkflow('some-future-kind')).toBe(true);
  });
});

describe('sourceArtifactKindSkipsAnalysis', () => {
  it('skips analysis when collateral generation seeds from an already-analyzed pain-points artifact', () => {
    expect(sourceArtifactKindSkipsAnalysis('collateral-generation', 'pain-points')).toBe(true);
  });

  it('does not skip analysis when collateral generation seeds from a raw call transcript', () => {
    expect(sourceArtifactKindSkipsAnalysis('collateral-generation', 'call-transcript')).toBe(false);
  });

  it('never skips analysis for other workflow kinds', () => {
    expect(sourceArtifactKindSkipsAnalysis('presentation-generation', 'pain-points')).toBe(false);
  });
});
