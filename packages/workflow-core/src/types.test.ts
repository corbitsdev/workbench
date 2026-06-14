import { describe, expect, test } from 'bun:test';
import {
  flattenStepCredentialRequirements,
  getOutputOptionIds,
  partitionOutputTypes,
  validateMultiIOInput,
} from './types';
import type { WorkflowType, WorkflowCredentialRequirement } from './types';

function workflowWithOutputs(ids: string[]): WorkflowType {
  return {
    kind: 'test',
    name: 'Test',
    description: 'Test workflow',
    steps: [],
    outputOptions: ids.map((id) => ({ id, label: id })),
  };
}

function workflowWithSteps(
  steps: { name: string; credentialRequirements: WorkflowCredentialRequirement[] }[]
): WorkflowType {
  return {
    kind: 'test',
    name: 'Test',
    description: 'Test workflow',
    steps: steps.map((s) => ({
      name: s.name,
      label: s.name,
      credentialRequirements: s.credentialRequirements,
    })),
  };
}

describe('flattenStepCredentialRequirements', () => {
  test('returns an empty list when no step declares any requirement', () => {
    const workflow = workflowWithSteps([
      { name: 'a', credentialRequirements: [] },
      { name: 'b', credentialRequirements: [] },
    ]);

    expect(flattenStepCredentialRequirements(workflow)).toEqual([]);
  });

  test('returns an empty list when the workflow has no steps at all', () => {
    const workflow = workflowWithSteps([]);

    expect(flattenStepCredentialRequirements(workflow)).toEqual([]);
  });

  test('collects requirements across multiple steps', () => {
    const granola: WorkflowCredentialRequirement = {
      providerName: 'granola',
      source: 'tenant',
      name: 'Granola',
    };
    const llm: WorkflowCredentialRequirement = {
      providerName: 'openai-compatible',
      source: 'tenant',
      name: 'LLM',
    };
    const workflow = workflowWithSteps([
      { name: 'intake', credentialRequirements: [granola] },
      { name: 'analyze', credentialRequirements: [llm] },
    ]);

    expect(flattenStepCredentialRequirements(workflow)).toEqual([granola, llm]);
  });

  test('de-duplicates by providerName + name across steps, keeping first occurrence', () => {
    const llmA: WorkflowCredentialRequirement = {
      providerName: 'openai-compatible',
      source: 'tenant',
      name: 'Collateral LLM',
    };
    const llmDuplicate: WorkflowCredentialRequirement = {
      providerName: 'openai-compatible',
      source: 'principal',
      name: 'Collateral LLM',
    };
    const workflow = workflowWithSteps([
      { name: 'analyze', credentialRequirements: [llmA] },
      { name: 'generate', credentialRequirements: [llmDuplicate] },
    ]);

    const result = flattenStepCredentialRequirements(workflow);

    expect(result).toHaveLength(1);
    // First occurrence wins even though the duplicate differs by source.
    expect(result[0]).toBe(llmA);
  });

  test('treats same providerName with different name as distinct requirements', () => {
    const myra: WorkflowCredentialRequirement = {
      providerName: 'openai-compatible',
      source: 'tenant',
      name: 'Myra LLM',
    };
    const workflowLlm: WorkflowCredentialRequirement = {
      providerName: 'openai-compatible',
      source: 'tenant',
      name: 'Workflow LLM',
    };
    const workflow = workflowWithSteps([
      { name: 'a', credentialRequirements: [myra] },
      { name: 'b', credentialRequirements: [workflowLlm] },
    ]);

    expect(flattenStepCredentialRequirements(workflow)).toEqual([myra, workflowLlm]);
  });

  test('treats a missing name the same as an empty name when de-duplicating', () => {
    const withoutName: WorkflowCredentialRequirement = {
      providerName: 'granola',
      source: 'tenant',
    };
    const withEmptyName: WorkflowCredentialRequirement = {
      providerName: 'granola',
      source: 'tenant',
      name: '',
    };
    const workflow = workflowWithSteps([
      { name: 'a', credentialRequirements: [withoutName] },
      { name: 'b', credentialRequirements: [withEmptyName] },
    ]);

    const result = flattenStepCredentialRequirements(workflow);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(withoutName);
  });

  test('de-duplicates within a single step as well as across steps', () => {
    const req: WorkflowCredentialRequirement = {
      providerName: 'granola',
      source: 'tenant',
      name: 'Granola',
    };
    const workflow = workflowWithSteps([{ name: 'a', credentialRequirements: [req, { ...req }] }]);

    expect(flattenStepCredentialRequirements(workflow)).toHaveLength(1);
  });

  test('preserves step-then-requirement ordering for distinct requirements', () => {
    const first: WorkflowCredentialRequirement = {
      providerName: 'p1',
      source: 'tenant',
      name: 'a',
    };
    const second: WorkflowCredentialRequirement = {
      providerName: 'p1',
      source: 'tenant',
      name: 'b',
    };
    const third: WorkflowCredentialRequirement = {
      providerName: 'p2',
      source: 'tenant',
      name: 'c',
    };
    const workflow = workflowWithSteps([
      { name: 'step1', credentialRequirements: [first, second] },
      { name: 'step2', credentialRequirements: [third] },
    ]);

    expect(flattenStepCredentialRequirements(workflow)).toEqual([first, second, third]);
  });

  test('does not mutate the input workflow or its requirement objects', () => {
    const req: WorkflowCredentialRequirement = {
      providerName: 'granola',
      source: 'tenant',
      name: 'Granola',
    };
    const workflow = workflowWithSteps([{ name: 'a', credentialRequirements: [req] }]);

    flattenStepCredentialRequirements(workflow);

    expect(workflow.steps[0]!.credentialRequirements).toEqual([req]);
    expect(req).toEqual({ providerName: 'granola', source: 'tenant', name: 'Granola' });
  });
});

describe('getOutputOptionIds', () => {
  test('returns the option ids in order', () => {
    expect(getOutputOptionIds(workflowWithOutputs(['case-study', 'one-pager']))).toEqual([
      'case-study',
      'one-pager',
    ]);
  });

  test('returns an empty list when no output options are declared', () => {
    const workflow: WorkflowType = {
      kind: 'test',
      name: 'Test',
      description: 'Test',
      steps: [],
    };
    expect(getOutputOptionIds(workflow)).toEqual([]);
  });
});

describe('partitionOutputTypes', () => {
  test('separates offered types from unknown ones', () => {
    const workflow = workflowWithOutputs(['case-study', 'one-pager']);
    expect(partitionOutputTypes(workflow, ['one-pager', 'mystery', 'case-study'])).toEqual({
      known: ['one-pager', 'case-study'],
      unknown: ['mystery'],
    });
  });
});

describe('validateMultiIOInput', () => {
  const workflow = workflowWithOutputs(['case-study', 'one-pager']);

  test('accepts a request with inputs and offered output types', () => {
    expect(
      validateMultiIOInput(workflow, {
        inputArtifactIds: ['art-1'],
        outputTypes: ['case-study'],
      })
    ).toBeNull();
  });

  test('rejects a request with no input artifacts', () => {
    expect(
      validateMultiIOInput(workflow, { inputArtifactIds: [], outputTypes: ['case-study'] })
    ).toBe('Select at least one input artifact');
  });

  test('rejects a request with no output types', () => {
    expect(validateMultiIOInput(workflow, { inputArtifactIds: ['art-1'], outputTypes: [] })).toBe(
      'Select at least one output type'
    );
  });

  test('rejects unknown output types loudly rather than dropping them', () => {
    expect(
      validateMultiIOInput(workflow, {
        inputArtifactIds: ['art-1'],
        outputTypes: ['case-study', 'mystery'],
      })
    ).toBe('Unknown output type(s): mystery');
  });
});
