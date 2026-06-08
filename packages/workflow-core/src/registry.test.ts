import { describe, expect, test } from 'bun:test';
import { WorkflowTypeRegistry, workflowRegistry } from './registry';
import type { WorkflowType } from './types';

function makeWorkflow(kind: string, overrides: Partial<WorkflowType> = {}): WorkflowType {
  return {
    kind,
    name: `Workflow ${kind}`,
    description: `Description for ${kind}`,
    steps: [],
    ...overrides,
  };
}

describe('WorkflowTypeRegistry', () => {
  test('get returns null for a kind that was never registered', () => {
    const registry = new WorkflowTypeRegistry();

    expect(registry.get('does-not-exist')).toBeNull();
  });

  test('get returns the exact workflow object that was registered', () => {
    const registry = new WorkflowTypeRegistry();
    const workflow = makeWorkflow('alpha');

    registry.register(workflow);

    expect(registry.get('alpha')).toBe(workflow);
  });

  test('register keys the workflow by its kind, not its name', () => {
    const registry = new WorkflowTypeRegistry();
    const workflow = makeWorkflow('the-kind', { name: 'A Friendly Name' });

    registry.register(workflow);

    expect(registry.get('the-kind')).toBe(workflow);
    expect(registry.get('A Friendly Name')).toBeNull();
  });

  test('registering the same kind twice replaces the prior entry (last write wins)', () => {
    const registry = new WorkflowTypeRegistry();
    const first = makeWorkflow('dup', { name: 'first' });
    const second = makeWorkflow('dup', { name: 'second' });

    registry.register(first);
    registry.register(second);

    expect(registry.get('dup')).toBe(second);
    expect(registry.list()).toHaveLength(1);
  });

  test('isValid is true only for registered kinds', () => {
    const registry = new WorkflowTypeRegistry();
    registry.register(makeWorkflow('known'));

    expect(registry.isValid('known')).toBe(true);
    expect(registry.isValid('unknown')).toBe(false);
  });

  test('isValid reflects a kind regardless of how many times it was registered', () => {
    const registry = new WorkflowTypeRegistry();
    registry.register(makeWorkflow('x'));
    registry.register(makeWorkflow('x'));

    expect(registry.isValid('x')).toBe(true);
  });

  test('list returns all registered workflows in registration (insertion) order', () => {
    const registry = new WorkflowTypeRegistry();
    const a = makeWorkflow('a');
    const b = makeWorkflow('b');
    const c = makeWorkflow('c');

    registry.register(a);
    registry.register(b);
    registry.register(c);

    expect(registry.list()).toEqual([a, b, c]);
  });

  test('re-registering an existing kind keeps its original list position', () => {
    const registry = new WorkflowTypeRegistry();
    const a = makeWorkflow('a');
    const b = makeWorkflow('b');
    const aUpdated = makeWorkflow('a', { name: 'updated' });

    registry.register(a);
    registry.register(b);
    registry.register(aUpdated);

    // Map preserves the original insertion slot for an updated key.
    expect(registry.list()).toEqual([aUpdated, b]);
  });

  test('list returns an empty array for a fresh registry', () => {
    const registry = new WorkflowTypeRegistry();

    expect(registry.list()).toEqual([]);
  });

  test('list returns a fresh array each call (mutating it does not corrupt the registry)', () => {
    const registry = new WorkflowTypeRegistry();
    registry.register(makeWorkflow('a'));

    const snapshot = registry.list();
    snapshot.pop();

    expect(registry.list()).toHaveLength(1);
  });

  test('distinct registry instances do not share state', () => {
    const one = new WorkflowTypeRegistry();
    const two = new WorkflowTypeRegistry();
    one.register(makeWorkflow('only-in-one'));

    expect(one.isValid('only-in-one')).toBe(true);
    expect(two.isValid('only-in-one')).toBe(false);
  });

  test('exported workflowRegistry is a shared singleton instance', () => {
    expect(workflowRegistry).toBeInstanceOf(WorkflowTypeRegistry);
  });
});
