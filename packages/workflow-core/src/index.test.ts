import { describe, expect, test } from 'bun:test';
import * as api from './index';
import { workflowRegistry as directRegistry } from './registry';
import { flattenStepCredentialRequirements as directFlatten } from './types';

describe('@workbench/workflow-core public surface', () => {
  test('re-exports the singleton workflowRegistry from registry', () => {
    expect(api.workflowRegistry).toBe(directRegistry);
  });

  test('re-exports flattenStepCredentialRequirements from types', () => {
    expect(api.flattenStepCredentialRequirements).toBe(directFlatten);
  });

  test('exposes the documented runtime exports as usable values', () => {
    // Assert the required surface is present and usable, not that it is
    // *exactly* these two — adding a new export should not fail this test.
    expect(api.workflowRegistry).toBeDefined();
    expect(typeof api.flattenStepCredentialRequirements).toBe('function');
  });
});
