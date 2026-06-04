import { describe, expect, it } from 'bun:test';
import { artifact, artifactVersion, painPoint, transcript, workbenchSession } from './schema';

describe('database schema', () => {
  it('has transcript table', () => {
    expect(transcript).toBeDefined();
    expect(transcript.content).toBeDefined();
    expect(transcript.source).toBeDefined();
    expect(transcript.createdAt).toBeDefined();
  });

  it('has workbenchSession table', () => {
    expect(workbenchSession).toBeDefined();
    expect(workbenchSession.transcriptId).toBeDefined();
    expect(workbenchSession.status).toBeDefined();
    expect(workbenchSession.createdAt).toBeDefined();
    expect(workbenchSession.updatedAt).toBeDefined();
  });

  it('has painPoint table', () => {
    expect(painPoint).toBeDefined();
    expect(painPoint.sessionId).toBeDefined();
    expect(painPoint.severity).toBeDefined();
    expect(painPoint.context).toBeDefined();
    expect(painPoint.quote).toBeDefined();
    expect(painPoint.selected).toBeDefined();
    expect(painPoint.createdAt).toBeDefined();
  });

  it('has artifact table', () => {
    expect(artifact).toBeDefined();
    expect(artifact.sessionId).toBeDefined();
    expect(artifact.parentId).toBeDefined();
    expect(artifact.painPointId).toBeDefined();
    expect(artifact.kind).toBeDefined();
    expect(artifact.title).toBeDefined();
    expect(artifact.content).toBeDefined();
    expect(artifact.status).toBeDefined();
    expect(artifact.version).toBeDefined();
    expect(artifact.createdAt).toBeDefined();
    expect(artifact.updatedAt).toBeDefined();
  });

  it('has artifactVersion table', () => {
    expect(artifactVersion).toBeDefined();
    expect(artifactVersion.artifactId).toBeDefined();
    expect(artifactVersion.version).toBeDefined();
    expect(artifactVersion.title).toBeDefined();
    expect(artifactVersion.content).toBeDefined();
    expect(artifactVersion.authorId).toBeDefined();
    expect(artifactVersion.createdAt).toBeDefined();
  });
});
