import { describe, expect, it } from 'bun:test';
import {
  canUseArtifactInWorkflow,
  sourceArtifactKindSkipsAnalysis,
  workflowsAcceptingArtifactKind,
  workflowAcceptsArtifactKind,
} from './artifact-workflow-eligibility';

describe('workflowAcceptsArtifactKind', () => {
  it('pain-point-collateral accepts only its specific source kinds', () => {
    expect(workflowAcceptsArtifactKind('pain-point-collateral', 'call-transcript')).toBe(true);
    expect(workflowAcceptsArtifactKind('pain-point-collateral', 'pain-points')).toBe(true);
    expect(workflowAcceptsArtifactKind('pain-point-collateral', 'email')).toBe(false);
  });

  it('gamma-presentation-creator accepts any artifact kind (general source)', () => {
    expect(workflowAcceptsArtifactKind('gamma-presentation-creator', 'email')).toBe(true);
    expect(workflowAcceptsArtifactKind('gamma-presentation-creator', 'pain-points')).toBe(true);
    expect(workflowAcceptsArtifactKind('gamma-presentation-creator', 'battlecard')).toBe(true);
  });

  it('rejects unknown workflow kinds', () => {
    expect(workflowAcceptsArtifactKind('nonexistent', 'call-transcript')).toBe(false);
  });
});

describe('workflowsAcceptingArtifactKind', () => {
  it('returns both workflows for a kind collateral accepts', () => {
    const kinds = workflowsAcceptingArtifactKind('pain-points');
    expect(kinds).toContain('pain-point-collateral');
    expect(kinds).toContain('gamma-presentation-creator');
  });

  it('returns only the general workflow for a kind collateral rejects', () => {
    const kinds = workflowsAcceptingArtifactKind('email');
    expect(kinds).toEqual(['gamma-presentation-creator']);
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
    expect(sourceArtifactKindSkipsAnalysis('pain-point-collateral', 'pain-points')).toBe(true);
  });

  it('does not skip analysis when collateral generation seeds from a raw call transcript', () => {
    expect(sourceArtifactKindSkipsAnalysis('pain-point-collateral', 'call-transcript')).toBe(false);
  });

  it('never skips analysis for other workflow kinds', () => {
    expect(sourceArtifactKindSkipsAnalysis('gamma-presentation-creator', 'pain-points')).toBe(
      false
    );
  });
});
