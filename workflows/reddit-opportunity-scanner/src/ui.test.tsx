/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { RunState, StepPhase, StepState } from '@intx/workflow';
import type { WorkflowPanelProps } from '@workbench/ui';

afterEach(cleanup);

const passthroughMotion = ({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) => React.createElement('div', { className }, children);

mock.module('framer-motion', () => ({
  motion: new Proxy({}, { get: () => passthroughMotion }),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const { Panel } = await import('./ui');

function stepState(stepId: string, phase: StepPhase): StepState {
  return { stepId, phase, currentAttempt: 1 } as StepState;
}

function makeState(phases: Record<string, StepPhase>): RunState {
  const steps = new Map<string, StepState>();
  for (const [id, phase] of Object.entries(phases)) {
    steps.set(id, stepState(id, phase));
  }
  return { steps } as unknown as RunState;
}

function renderPanel(overrides: Partial<WorkflowPanelProps> = {}) {
  const onSignal = mock((_name: string, _payload?: unknown) => {});
  const onClose = mock(() => {});
  const props: WorkflowPanelProps = {
    deploymentId: 'dep-1',
    state: makeState({ intake: 'completed', analyze: 'completed', review: 'awaiting-signal' }),
    connected: true,
    stepOutputs: {},
    onSignal,
    onClose,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

describe('reddit-opportunity-scanner Panel', () => {
  it('marks completed steps with a checkmark and the awaiting step as current', () => {
    renderPanel();
    // intake + analyze completed
    expect(screen.getAllByText('✓').length).toBe(2);
    // review is current (step 3)
    screen.getByText('3');
  });

  it('renders inferred keywords, subreddits, and audience from analyze output', () => {
    renderPanel({
      stepOutputs: {
        analyze: {
          sells: 'Developer tooling',
          keywords: ['observability', 'tracing'],
          subreddits: ['devops', 'sre'],
          audience: ['platform engineers'],
        },
      },
    });
    screen.getByText('Developer tooling');
    screen.getByText('observability');
    screen.getByText('devops');
    screen.getByText('platform engineers');
  });

  it('fires onSignal with approval when Approve is clicked on the review step', () => {
    const { onSignal } = renderPanel();
    fireEvent.click(screen.getByText('Approve and scan'));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['recommendation-review', { approved: true }]);
  });

  it('does not show the approve action when review is not awaiting a signal', () => {
    renderPanel({
      state: makeState({ intake: 'completed', analyze: 'in-flight' }),
    });
    expect(screen.queryByText('Approve and scan')).toBeNull();
  });

  it('renders ranked Reddit opportunities from scan output', () => {
    renderPanel({
      state: makeState({
        intake: 'completed',
        analyze: 'completed',
        review: 'completed',
        scan: 'completed',
      }),
      stepOutputs: {
        scan: {
          opportunities: [
            {
              title: 'Anyone using X for tracing?',
              subreddit: 'devops',
              score: 92,
              reason: 'Active buying-intent thread',
              url: 'https://reddit.com/r/devops/x',
            },
          ],
        },
      },
    });
    screen.getByText('Anyone using X for tracing?');
    screen.getByText('r/devops');
    screen.getByText('92');
    screen.getByText('Active buying-intent thread');
  });

  it('shows a failure banner with the step error message when a step failed', () => {
    const steps = new Map<string, StepState>();
    steps.set('intake', stepState('intake', 'completed'));
    steps.set('analyze', {
      stepId: 'analyze',
      phase: 'failed',
      currentAttempt: 1,
      lastError: { message: 'site fetch timed out' },
    } as StepState);
    renderPanel({ state: { steps } as unknown as RunState });
    screen.getByText('This run failed.');
    screen.getByText('site fetch timed out');
  });

  it('shows a malformed-output error when a completed step output fails validation', () => {
    renderPanel({
      state: makeState({ intake: 'completed', analyze: 'completed' }),
      stepOutputs: { analyze: { keywords: 'not-an-array' } },
    });
    screen.getByText('Couldn’t read the business analysis output.');
  });
});
