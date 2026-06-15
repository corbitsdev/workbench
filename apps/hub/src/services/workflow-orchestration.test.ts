import { describe, expect, it, beforeAll } from 'bun:test';
import { workflowRegistry } from '@workbench/workflow-core';
import {
  collateralGenerationWorkflow,
  presentationGenerationWorkflow,
} from '@workbench/gtm-workflows';
import {
  mapDbStatusToSessionStatus,
  deriveCurrentStepForWorkflow,
  isWorkflowOwner,
  validateWorkflowInput,
} from './workflow-orchestration';

beforeAll(() => {
  workflowRegistry.register(collateralGenerationWorkflow);
  workflowRegistry.register(presentationGenerationWorkflow);
});

describe('mapDbStatusToSessionStatus', () => {
  it('maps each valid DB status to its session status', () => {
    expect(mapDbStatusToSessionStatus('pending')).toBe('pending');
    expect(mapDbStatusToSessionStatus('analyzing')).toBe('analyzing');
    // running is the post-analyze "ready" state, not active generation.
    expect(mapDbStatusToSessionStatus('running')).toBe('ready');
    expect(mapDbStatusToSessionStatus('generating')).toBe('generating');
    expect(mapDbStatusToSessionStatus('reviewing')).toBe('reviewing');
    expect(mapDbStatusToSessionStatus('done')).toBe('done');
    expect(mapDbStatusToSessionStatus('failed')).toBe('failed');
  });

  it('throws on an unknown status', () => {
    expect(() => mapDbStatusToSessionStatus('ready')).toThrow('Unknown workflow status: ready');
  });
});

describe('deriveCurrentStepForWorkflow', () => {
  it('uses the presentation branch (3-step) mapping', () => {
    const steps = presentationGenerationWorkflow.steps.map((s) => s.name);
    const [first, second, third] = steps;
    if (!first || !second || !third) throw new Error('presentation workflow missing steps');
    expect(deriveCurrentStepForWorkflow('pending', 'presentation-generation')).toBe(first);
    expect(deriveCurrentStepForWorkflow('failed', 'presentation-generation')).toBe(first);
    expect(deriveCurrentStepForWorkflow('analyzing', 'presentation-generation')).toBe(second);
    expect(deriveCurrentStepForWorkflow('running', 'presentation-generation')).toBe(third);
    expect(deriveCurrentStepForWorkflow('done', 'presentation-generation')).toBe(third);
  });

  it('uses the generic branch for collateral workflows', () => {
    const steps = collateralGenerationWorkflow.steps.map((s) => s.name);
    const firstPostIntake = steps[1];
    const lastStep = steps[steps.length - 1];
    if (!firstPostIntake || !lastStep) throw new Error('collateral workflow missing steps');
    expect(deriveCurrentStepForWorkflow('pending', 'collateral-generation')).toBe(firstPostIntake);
    expect(deriveCurrentStepForWorkflow('analyzing', 'collateral-generation')).toBe(
      firstPostIntake
    );
    expect(deriveCurrentStepForWorkflow('running', 'collateral-generation')).toBe(lastStep);
    expect(deriveCurrentStepForWorkflow('done', 'collateral-generation')).toBe(lastStep);
    expect(deriveCurrentStepForWorkflow('failed', 'collateral-generation')).toBe('intake');
  });

  it('throws on an unknown status', () => {
    expect(() => deriveCurrentStepForWorkflow('bogus', 'collateral-generation')).toThrow(
      'Unknown workflow status: bogus'
    );
  });
});

describe('isWorkflowOwner', () => {
  it('returns true only when principal ids match', () => {
    expect(isWorkflowOwner({ principalId: 'p-1' }, { principalId: 'p-1' })).toBe(true);
    expect(isWorkflowOwner({ principalId: 'p-1' }, { principalId: 'p-2' })).toBe(false);
  });
});

describe('validateWorkflowInput', () => {
  it('rejects an unknown workflow kind', () => {
    const result = validateWorkflowInput('does-not-exist', {});
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('Workflow not found');
  });

  it('rejects input missing a required field', () => {
    const result = validateWorkflowInput('collateral-generation', {
      transcriptSource: 'paste',
      callTitle: 'Call',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('transcriptId');
  });

  it('accepts input satisfying the required fields', () => {
    const result = validateWorkflowInput('collateral-generation', {
      transcriptId: 'tx-1',
      transcriptSource: 'paste',
      callTitle: 'Call',
    });
    expect(result.valid).toBe(true);
  });
});
