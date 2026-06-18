import { describe, expect, it } from 'bun:test';
import { LLM_CREDENTIAL_NAME, LLM_DEFAULT_MODEL } from '@workbench/agents';
import { collateralGenerationWorkflow as fromRoot } from './index';
import { collateralGenerationWorkflow as fromSubpath } from './collateral-generation';
import { collateralGenerationWorkflow as fromModule } from './collateral-generation/workflow';
import { workflowRegistry, flattenStepCredentialRequirements } from '@workbench/workflow-core';

/**
 * Behavioral net for how gtm-workflows is actually consumed: the hub registers
 * the workflow in a WorkflowTypeRegistry and derives a flattened credential list
 * for its catalog endpoint. These tests pin the export surface and the integration
 * behavior the hub depends on (see apps/hub/src/routes/workflow.ts).
 */

describe('package export surface', () => {
  it('re-exports the same workflow object from root, subpath, and module', () => {
    expect(fromRoot).toBe(fromModule);
    expect(fromSubpath).toBe(fromModule);
  });
});

describe('registry integration (mirrors hub registration)', () => {
  it('is retrievable by kind once registered', () => {
    workflowRegistry.register(fromRoot);
    expect(workflowRegistry.get('collateral-generation')).toBe(fromRoot);
    expect(workflowRegistry.isValid('collateral-generation')).toBe(true);
  });

  it('does not validate an unrelated kind', () => {
    expect(workflowRegistry.isValid('definitely-not-a-real-kind')).toBe(false);
    expect(workflowRegistry.get('definitely-not-a-real-kind')).toBeNull();
  });
});

describe('flattened credential requirements (mirrors catalog endpoint)', () => {
  it('de-duplicates the shared openai-compatible LLM across analyze/generate', () => {
    const flat = flattenStepCredentialRequirements(fromRoot);
    const llm = flat.filter((r) => r.providerName === 'openai-compatible');
    expect(llm).toHaveLength(1);
  });

  it('surfaces exactly the Granola and openai-compatible LLM credentials, in first-seen order', () => {
    const flat = flattenStepCredentialRequirements(fromRoot);
    expect(flat).toEqual([
      { providerName: 'granola', source: 'tenant', name: 'Granola' },
      {
        providerName: 'openai-compatible',
        source: 'tenant',
        name: LLM_CREDENTIAL_NAME,
        defaultModel: LLM_DEFAULT_MODEL,
      },
    ]);
  });
});
