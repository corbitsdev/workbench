/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { RunState, StepState } from '@intx/workflow';
import type { WorkflowPanelProps } from '@workbench/ui';

afterEach(cleanup);

// framer-motion (used by HorizontalStepper) is not compatible with Happy DOM.
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
}));

const { Panel } = await import('./ui');

type Phase = StepState['phase'];

function makeState(phases: Partial<Record<string, Phase>>): RunState {
  const steps = new Map<string, StepState>();
  for (const [stepId, phase] of Object.entries(phases)) {
    if (!phase) continue;
    steps.set(stepId, { stepId, phase, currentAttempt: 1 } as unknown as StepState);
  }
  return {
    phase: 'running',
    steps,
  } as unknown as RunState;
}

function renderPanel(overrides: Partial<WorkflowPanelProps> = {}) {
  const onSignal = mock((_name: string, _payload?: unknown) => {});
  const onClose = mock(() => {});
  const props: WorkflowPanelProps = {
    deploymentId: 'dep_1',
    state: makeState({}),
    connected: true,
    stepOutputs: {},
    onSignal,
    onClose,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

describe('ab-compare Panel', () => {
  it('renders the header and every step label', () => {
    renderPanel();
    expect(screen.getByText('A/B Compare')).toBeDefined();
    for (const label of ['Input', 'Execute', 'Compare', 'Review', 'Persist']) {
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('renders provider branch outputs from stepOutputs.execute', () => {
    renderPanel({
      state: makeState({ execute: 'completed' }),
      stepOutputs: {
        execute: {
          branches: [
            { provider: 'OpenAI', model: 'gpt-x', output: 'Variant A copy' },
            { provider: 'Anthropic', model: 'claude-x', output: 'Variant B copy' },
          ],
        },
      },
    });
    expect(screen.getByText('OpenAI')).toBeDefined();
    expect(screen.getByText('Variant A copy')).toBeDefined();
    expect(screen.getByText('Anthropic')).toBeDefined();
    expect(screen.getByText('Variant B copy')).toBeDefined();
  });

  it('renders the blind ranking from stepOutputs.compare', () => {
    renderPanel({
      state: makeState({ compare: 'completed' }),
      stepOutputs: {
        compare: {
          summary: 'B reads cleaner.',
          ranking: [
            { rank: 1, label: 'Variant B', rationale: 'tighter hook' },
            { rank: 2, label: 'Variant A', rationale: 'wordy' },
          ],
        },
      },
    });
    expect(screen.getByText('B reads cleaner.')).toBeDefined();
    expect(screen.getByText('Variant B')).toBeDefined();
    expect(screen.getByText('tighter hook')).toBeDefined();
    expect(screen.getByText('Variant A')).toBeDefined();
  });

  it('fires onSignal with approval payload when Approve is clicked', () => {
    const { onSignal } = renderPanel({
      state: makeState({ review: 'awaiting-signal' }),
    });
    fireEvent.click(screen.getByText('Approve comparison'));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['comparison-review', { approved: true }]);
  });

  it('disables Approve while disconnected', () => {
    const { onSignal } = renderPanel({
      state: makeState({ review: 'awaiting-signal' }),
      connected: false,
    });
    const button = screen.getByText('Approve comparison') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it('does not show the Approve button before the review step awaits a signal', () => {
    renderPanel({ state: makeState({ compare: 'completed' }) });
    expect(screen.queryByText('Approve comparison')).toBeNull();
  });

  it('renders saved artifacts from stepOutputs.persist', () => {
    renderPanel({
      state: makeState({ persist: 'completed' }),
      stepOutputs: {
        persist: { artifacts: [{ id: 'art_1', title: 'Comparison report', kind: 'doc' }] },
      },
    });
    expect(screen.getByText('Comparison report')).toBeDefined();
    expect(screen.getByText('doc')).toBeDefined();
  });

  it('shows a failure message when the run failed', () => {
    renderPanel({ state: { phase: 'failed', steps: new Map() } as unknown as RunState });
    expect(screen.getByText(/This run failed/)).toBeDefined();
  });

  it('fires onClose when Close is clicked', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
