/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import { buildSteps } from './steps';
import { type StepName } from './types';

describe('buildSteps', () => {
  const allLabels: Record<StepName, string> = {
    intake: 'Call source',
    analyze: 'Agent review',
    generate: 'Approve collateral',
  };

  it('marks intake as current for intake step', () => {
    const steps = buildSteps('intake', allLabels);
    expect(steps[0]?.status).toBe('current');
    expect(steps[1]?.status).toBe('pending');
  });

  it('marks completed steps before analyze and current at analyze', () => {
    const steps = buildSteps('analyze', allLabels);
    expect(steps[0]?.status).toBe('completed');
    expect(steps[1]?.status).toBe('current');
    expect(steps[2]?.status).toBe('pending');
  });

  it('marks completed steps before generate and current at generate', () => {
    const steps = buildSteps('generate', allLabels);
    expect(steps[0]?.status).toBe('completed');
    expect(steps[1]?.status).toBe('completed');
    expect(steps[2]?.status).toBe('current');
  });

  it('marks all completed when workflow is done', () => {
    const steps = buildSteps('generate', allLabels, true);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
  });
});
