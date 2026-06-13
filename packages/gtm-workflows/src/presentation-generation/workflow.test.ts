import { describe, expect, it } from 'bun:test';
import { presentationGenerationWorkflow } from './workflow';

describe('presentationGenerationWorkflow', () => {
  it('has kind presentation-generation', () => {
    expect(presentationGenerationWorkflow.kind).toBe('presentation-generation');
  });

  it('has exactly three steps named template, source, generate', () => {
    expect(presentationGenerationWorkflow.steps).toHaveLength(3);
    const names = presentationGenerationWorkflow.steps.map((s) => s.name);
    expect(names).toEqual(['template', 'source', 'generate']);
  });

  it('template step has empty credential requirements', () => {
    const step = presentationGenerationWorkflow.steps.find((s) => s.name === 'template');
    expect(step?.credentialRequirements).toEqual([]);
  });

  it('source step has empty credentialRequirements (granola is tool-only, not an inference provider)', () => {
    const step = presentationGenerationWorkflow.steps.find((s) => s.name === 'source');
    expect(step?.credentialRequirements).toEqual([]);
    expect(step?.tools).toContain('granola_list_notes');
    expect(step?.tools).toContain('granola_get_note');
  });

  it('generate step has empty credential requirements', () => {
    const step = presentationGenerationWorkflow.steps.find((s) => s.name === 'generate');
    expect(step?.credentialRequirements).toEqual([]);
  });

  it('deriveRunTitle returns companyName when present', () => {
    expect(presentationGenerationWorkflow.deriveRunTitle?.({ companyName: 'Acme Corp' })).toBe(
      'Acme Corp'
    );
  });

  it('deriveRunTitle falls back to callTitle', () => {
    expect(presentationGenerationWorkflow.deriveRunTitle?.({ callTitle: 'Discovery Call' })).toBe(
      'Discovery Call'
    );
  });

  it('deriveRunTitle falls back to artifactTitle', () => {
    expect(presentationGenerationWorkflow.deriveRunTitle?.({ artifactTitle: 'Case Study' })).toBe(
      'Case Study'
    );
  });

  it('deriveRunTitle returns null when no title info', () => {
    expect(presentationGenerationWorkflow.deriveRunTitle?.({})).toBeNull();
  });

  it('createIntakeArtifacts with granola source creates a call-transcript artifact with status approved', () => {
    const artifacts = presentationGenerationWorkflow.createIntakeArtifacts?.({
      input: { transcriptSource: 'granola' },
      content: 'call transcript text',
      callTitle: 'Discovery',
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts?.[0]?.kind).toBe('call-transcript');
    expect(artifacts?.[0]?.status).toBe('approved');
  });

  it('createIntakeArtifacts with paste source creates a call-transcript artifact with status approved', () => {
    const artifacts = presentationGenerationWorkflow.createIntakeArtifacts?.({
      input: { transcriptSource: 'paste' },
      content: 'pasted notes',
      callTitle: 'Notes',
    });
    expect(artifacts).toHaveLength(1);
    expect(artifacts?.[0]?.kind).toBe('call-transcript');
    expect(artifacts?.[0]?.status).toBe('approved');
  });

  it('createIntakeArtifacts with artifact source returns empty array', () => {
    const artifacts = presentationGenerationWorkflow.createIntakeArtifacts?.({
      input: { transcriptSource: 'artifact' },
      content: '',
    });
    expect(artifacts).toHaveLength(0);
  });
});
