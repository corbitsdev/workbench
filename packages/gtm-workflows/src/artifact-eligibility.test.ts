import { describe, expect, it } from 'bun:test';
import { canUseArtifactInWorkflow, WORKFLOW_ELIGIBLE_ARTIFACT_KINDS } from './artifact-eligibility';

describe('canUseArtifactInWorkflow', () => {
  it('accepts pain-points and call-transcript', () => {
    expect(canUseArtifactInWorkflow('pain-points')).toBe(true);
    expect(canUseArtifactInWorkflow('call-transcript')).toBe(true);
  });

  it('rejects kinds that cannot seed a workflow', () => {
    expect(canUseArtifactInWorkflow('email')).toBe(false);
    expect(canUseArtifactInWorkflow('presentation')).toBe(false);
    expect(canUseArtifactInWorkflow('')).toBe(false);
  });

  it('matches the exported eligible-kinds set', () => {
    for (const kind of WORKFLOW_ELIGIBLE_ARTIFACT_KINDS) {
      expect(canUseArtifactInWorkflow(kind)).toBe(true);
    }
  });
});
