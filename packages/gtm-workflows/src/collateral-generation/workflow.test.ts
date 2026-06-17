import { describe, expect, it } from 'bun:test';
import { LLM_CREDENTIAL_NAME } from '@workbench/agents';
import { collateralGenerationWorkflow } from './workflow';
import type { WorkflowStepDefinition } from '@workbench/workflow-core';

/**
 * Behavioral regression net for the collateral-generation workflow definition.
 *
 * This workflow is pure data consumed by apps/hub/src/routes/workflow.ts, which
 * relies on: the exact step sequence, each step's `name` (used as the assignment
 * key), each step's `tools` allowlist, each step's `credentialRequirements`, and
 * the input schema's required fields. These tests fail loudly if any of those
 * load-bearing facts change.
 */

const stepByName = (name: string): WorkflowStepDefinition => {
  const step = collateralGenerationWorkflow.steps.find((s) => s.name === name);
  if (!step) throw new Error(`step ${name} not found`);
  return step;
};

describe('collateral-generation workflow identity', () => {
  it('declares the collateral-generation kind so the registry keys on it', () => {
    expect(collateralGenerationWorkflow.kind).toBe('collateral-generation');
  });

  it('keeps a human-facing name and description for the catalog endpoint', () => {
    expect(collateralGenerationWorkflow.name).toBe('Collateral Generation');
    expect(collateralGenerationWorkflow.description).toContain('call transcripts');
  });
});

describe('collateral-generation step sequence', () => {
  it('runs intake -> analyze -> generate in that exact order', () => {
    expect(collateralGenerationWorkflow.steps.map((s) => s.name)).toEqual([
      'intake',
      'analyze',
      'generate',
    ]);
  });

  it('exposes exactly three steps', () => {
    expect(collateralGenerationWorkflow.steps).toHaveLength(3);
  });

  it('gives every step a unique name (assignment keys cannot collide)', () => {
    const names = collateralGenerationWorkflow.steps.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every step a non-empty label for the UI', () => {
    for (const step of collateralGenerationWorkflow.steps) {
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});

describe('collateral-generation per-step credential requirements', () => {
  it('requires a tenant-owned Granola credential only on intake', () => {
    expect(stepByName('intake').credentialRequirements).toEqual([
      { providerName: 'granola', source: 'tenant', name: 'Granola' },
    ]);
  });

  it('requires a tenant-owned openai-compatible LLM on analyze and generate', () => {
    for (const name of ['analyze', 'generate']) {
      expect(stepByName(name).credentialRequirements).toEqual([
        { providerName: 'openai-compatible', source: 'tenant', name: LLM_CREDENTIAL_NAME },
      ]);
    }
  });

  it('declares every credential requirement as tenant-sourced', () => {
    for (const step of collateralGenerationWorkflow.steps) {
      for (const req of step.credentialRequirements) {
        expect(req.source).toBe('tenant');
      }
    }
  });
});

describe('collateral-generation per-step tool allowlist', () => {
  it('grants intake exactly the two Granola read tools', () => {
    expect(stepByName('intake').tools).toEqual(['granola_list_notes', 'granola_get_note']);
  });

  it('grants no tools to any step other than intake', () => {
    for (const name of ['analyze', 'generate']) {
      expect(stepByName(name).tools).toBeUndefined();
    }
  });

  it('only references Granola-provider tools where tools are declared', () => {
    for (const step of collateralGenerationWorkflow.steps) {
      for (const tool of step.tools ?? []) {
        expect(tool.startsWith('granola_')).toBe(true);
      }
    }
  });
});

describe('collateral-generation input schema', () => {
  it('requires transcriptId and transcriptSource so the hub can reject incomplete launches', () => {
    const schema = collateralGenerationWorkflow.inputSchema as { required?: string[] };
    expect(schema.required).toEqual(['transcriptId', 'transcriptSource']);
  });

  it('constrains transcriptSource to paste, granola, or artifact', () => {
    const schema = collateralGenerationWorkflow.inputSchema as {
      properties: { transcriptSource: { enum: string[] } };
    };
    expect(schema.properties.transcriptSource.enum).toEqual(['paste', 'granola', 'artifact']);
  });

  it('does not mark the optional companyName field as required', () => {
    const schema = collateralGenerationWorkflow.inputSchema as { required: string[] };
    expect(schema.required).not.toContain('companyName');
  });
});

describe('collateral-generation artifact behavior', () => {
  it('keeps the requested collateral outputs that are valid kinds', () => {
    const selected = collateralGenerationWorkflow.selectGenerateArtifactKinds?.([
      'linkedin-post',
      'blog',
    ]);
    expect(selected).toEqual(['linkedin-post', 'blog']);
  });

  it('returns no kinds when no requested kind is valid', () => {
    const selected = collateralGenerationWorkflow.selectGenerateArtifactKinds?.([
      'pain-points-linkedin-post',
      'pain-points-blog',
    ]);
    expect(selected).toEqual([]);
  });

  it('creates transcript artifacts during intake', () => {
    const artifacts = collateralGenerationWorkflow.createIntakeArtifacts?.({
      input: { transcriptId: 'tx-1', transcriptSource: 'paste' },
      content: 'Call text',
      callTitle: 'Demo call',
    });
    expect(artifacts).toEqual([
      {
        kind: 'call-transcript',
        title: 'Transcript — Demo call',
        content: 'Call text',
        status: 'approved',
        version: 1,
      },
    ]);
  });

  it('creates a pain-points document artifact from analysis output', () => {
    const artifacts = collateralGenerationWorkflow.createAnalyzeArtifacts?.({
      input: { companyName: 'Acme' },
      companyName: 'Acme',
      painPoints: [{ severity: 'high', context: 'Manual work', quote: 'Too much copying' }],
    });
    expect(artifacts?.[0]).toMatchObject({
      kind: 'pain-points',
      title: 'Pain Points — Acme',
      status: 'approved',
    });
    expect(artifacts?.[0]?.content).toContain('Manual work');
  });
});

describe('collateral-generation output schema', () => {
  it('produces an array of artifacts with kind, title, and content', () => {
    const schema = collateralGenerationWorkflow.outputSchema as {
      properties: {
        artifacts: { type: string; items: { properties: Record<string, unknown> } };
      };
    };
    expect(schema.properties.artifacts.type).toBe('array');
    expect(Object.keys(schema.properties.artifacts.items.properties).sort()).toEqual([
      'content',
      'kind',
      'title',
    ]);
  });
});
