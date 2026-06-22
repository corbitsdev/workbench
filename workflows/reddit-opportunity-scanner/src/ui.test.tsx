/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { RunState, StepPhase, StepState } from '@intx/workflow';
import type { WorkflowPanelProps } from '@workbench/ui';

afterEach(cleanup);

// Stub framer-motion before importing the module under test
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    state: null,
    connected: true,
    stepOutputs: {},
    signalPending: false,
    onSignal,
    onClose,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

const SCAN_OUTPUT_REPLY = JSON.stringify({
  opportunities: [
    {
      id: 'opp-1',
      title: 'Anyone using X for tracing?',
      subreddit: 'devops',
      signal: 'buying-signal',
      detail: 'Active buying-intent thread.',
      url: 'https://reddit.com/r/devops/x',
    },
    {
      id: 'opp-2',
      title: 'Frustrated with current APM tools',
      subreddit: 'sre',
      signal: 'pain-point',
      detail: 'Users complaining about cost.',
    },
  ],
});

// scan agent step produces { reply: string, turn: unknown }
const SCAN_STEP_OUTPUT = { reply: SCAN_OUTPUT_REPLY };

describe('reddit-opportunity-scanner Panel', () => {
  // ── Stepper ──────────────────────────────────────────────────────────────

  it('shows all four step labels in the stepper', () => {
    renderPanel({ state: makeState({ intake: 'awaiting-signal' }) });
    screen.getByText('Intake');
    screen.getByText('Scan');
    screen.getByText('Review');
    screen.getByText('Persist');
  });

  it('marks completed steps with a checkmark and the active step as current', () => {
    renderPanel({
      state: makeState({ intake: 'completed', scan: 'in-flight' }),
    });
    // intake is completed → shows checkmark
    expect(screen.getAllByText('✓').length).toBeGreaterThanOrEqual(1);
    // scan is current → shows step number 2
    screen.getByText('2');
  });

  // ── Intake screen ────────────────────────────────────────────────────────

  it('renders the intake chip form while intake is awaiting-signal', () => {
    renderPanel({ state: makeState({ intake: 'awaiting-signal' }) });
    screen.getByLabelText('Subreddits (without r/)');
    screen.getByLabelText('Keywords');
    screen.getByText('Start scan');
  });

  it('allows adding subreddits and keywords via Enter', () => {
    renderPanel({ state: makeState({ intake: 'awaiting-signal' }) });
    const subredditInput = screen.getByLabelText('Subreddits (without r/)');
    fireEvent.change(subredditInput, { target: { value: 'devops' } });
    fireEvent.keyDown(subredditInput, { key: 'Enter' });
    screen.getByText('devops');
  });

  it('fires intake signal with subreddits and keywords when submitted', () => {
    const { onSignal } = renderPanel({ state: makeState({ intake: 'awaiting-signal' }) });

    const subredditInput = screen.getByLabelText('Subreddits (without r/)');
    fireEvent.change(subredditInput, { target: { value: 'devops' } });
    fireEvent.keyDown(subredditInput, { key: 'Enter' });

    const keywordInput = screen.getByLabelText('Keywords');
    fireEvent.change(keywordInput, { target: { value: 'observability' } });
    fireEvent.keyDown(keywordInput, { key: 'Enter' });

    fireEvent.click(screen.getByText('Start scan'));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual([
      'intake',
      { subreddits: ['devops'], keywords: ['observability'] },
    ]);
  });

  it('does not submit intake when no subreddits are added', () => {
    const { onSignal } = renderPanel({ state: makeState({ intake: 'awaiting-signal' }) });

    const keywordInput = screen.getByLabelText('Keywords');
    fireEvent.change(keywordInput, { target: { value: 'observability' } });
    fireEvent.keyDown(keywordInput, { key: 'Enter' });

    fireEvent.click(screen.getByText('Start scan'));
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('does not submit intake when no keywords are added', () => {
    const { onSignal } = renderPanel({ state: makeState({ intake: 'awaiting-signal' }) });

    const subredditInput = screen.getByLabelText('Subreddits (without r/)');
    fireEvent.change(subredditInput, { target: { value: 'devops' } });
    fireEvent.keyDown(subredditInput, { key: 'Enter' });

    fireEvent.click(screen.getByText('Start scan'));
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('does not submit intake while a signal is pending', () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: 'awaiting-signal' }),
      signalPending: true,
    });

    const subredditInput = screen.getByLabelText('Subreddits (without r/)');
    fireEvent.change(subredditInput, { target: { value: 'devops' } });
    fireEvent.keyDown(subredditInput, { key: 'Enter' });

    const keywordInput = screen.getByLabelText('Keywords');
    fireEvent.change(keywordInput, { target: { value: 'observability' } });
    fireEvent.keyDown(keywordInput, { key: 'Enter' });

    const button = screen.getByText('Start scan') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).not.toHaveBeenCalled();
  });

  // ── Scan screen ──────────────────────────────────────────────────────────

  it('shows a loading state while scan is in-flight', () => {
    renderPanel({
      state: makeState({ intake: 'completed', scan: 'in-flight' }),
      stepOutputs: {},
    });
    screen.getByText('Scanning Reddit');
  });

  it('renders opportunities from scan output when scan completes', () => {
    renderPanel({
      state: makeState({ intake: 'completed', scan: 'completed', review: 'awaiting-signal' }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });
    // scan screen is no longer active (review is next), but review screen reads scan output
    // — confirm opportunities appear in the review screen
    screen.getByText('Anyone using X for tracing?');
    screen.getByText('Frustrated with current APM tools');
  });

  it('shows a malformed-output error when scan output fails validation', () => {
    renderPanel({
      state: makeState({ intake: 'completed', scan: 'completed', review: 'awaiting-signal' }),
      stepOutputs: {
        scan: { reply: 'not valid json{{' },
      },
    });
    screen.getByText('No opportunities to review.');
  });

  // ── Review screen ─────────────────────────────────────────────────────────

  it('renders opportunity cards with checkboxes in review screen', () => {
    renderPanel({
      state: makeState({ intake: 'completed', scan: 'completed', review: 'awaiting-signal' }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });
    screen.getByText('Anyone using X for tracing?');
    screen.getByText('r/devops');
    screen.getByText('Active buying-intent thread.');
  });

  it('fires recommendation-review signal with selected opportunity objects', () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: 'completed', scan: 'completed', review: 'awaiting-signal' }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });

    // click first opportunity card to select it
    fireEvent.click(screen.getByText('Anyone using X for tracing?'));

    // click the save button
    fireEvent.click(screen.getByText('Save 1 opportunity'));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]?.[0]).toBe('recommendation-review');
    const payload = onSignal.mock.calls[0]?.[1] as { selected: unknown[] };
    expect(payload.selected).toHaveLength(1);
    expect((payload.selected[0] as { id: string }).id).toBe('opp-1');
  });

  it('does not fire signal when no opportunities are selected', () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: 'completed', scan: 'completed', review: 'awaiting-signal' }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });
    // save button is disabled — clicking it should not fire
    const saveButton = screen.getByText('Save opportunities');
    expect(saveButton.closest('button')?.disabled).toBe(true);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('can select and deselect opportunities', () => {
    const { onSignal } = renderPanel({
      state: makeState({ intake: 'completed', scan: 'completed', review: 'awaiting-signal' }),
      stepOutputs: { scan: SCAN_STEP_OUTPUT },
    });

    // select first then deselect
    const firstCard = screen.getByText('Anyone using X for tracing?');
    fireEvent.click(firstCard);
    fireEvent.click(firstCard); // deselect

    // select second
    fireEvent.click(screen.getByText('Frustrated with current APM tools'));

    fireEvent.click(screen.getByText('Save 1 opportunity'));

    expect(onSignal).toHaveBeenCalledTimes(1);
    const payload = onSignal.mock.calls[0]?.[1] as { selected: unknown[] };
    expect((payload.selected[0] as { id: string }).id).toBe('opp-2');
  });

  // ── Persist screen ────────────────────────────────────────────────────────

  it('shows a loading state while persist is in-flight', () => {
    renderPanel({
      state: makeState({
        intake: 'completed',
        scan: 'completed',
        review: 'completed',
        persist: 'in-flight',
      }),
      stepOutputs: {},
    });
    screen.getByText('Saving artifacts');
  });

  it('renders saved artifacts from persist output when run completes', () => {
    const persistOutput = [
      {
        callId: 'c1',
        content: JSON.stringify({ artifactId: 'art-1', title: 'Opp 1', kind: 'document' }),
      },
    ];
    renderPanel({
      state: makeState({
        intake: 'completed',
        scan: 'completed',
        review: 'completed',
        persist: 'completed',
      }),
      stepOutputs: { persist: persistOutput },
    });
    screen.getByText('Done — 1 artifact saved');
    screen.getByText('Opp 1');
  });

  it('shows a Close button on the persist screen and calls onClose', () => {
    renderPanel({
      state: makeState({
        intake: 'completed',
        scan: 'completed',
        review: 'completed',
        persist: 'completed',
      }),
      stepOutputs: { persist: [] },
    });
    screen.getByText('Done — 0 artifacts saved');
    screen.getByText('Close'); // the persist-screen close button
  });

  // ── Failure ───────────────────────────────────────────────────────────────

  it('shows a failure banner with the step error when a step fails', () => {
    const steps = new Map<string, StepState>();
    steps.set('intake', stepState('intake', 'completed'));
    steps.set('scan', {
      stepId: 'scan',
      phase: 'failed',
      currentAttempt: 1,
      lastError: { message: 'Reddit API rate limited' },
    } as StepState);
    renderPanel({ state: { steps, phase: 'failed' } as unknown as RunState });
    screen.getByText('This run failed.');
    screen.getByText('Reddit API rate limited');
  });

  // ── Guided layout — only active step rendered ────────────────────────────

  it('does not render intake form while scan is active', () => {
    renderPanel({
      state: makeState({ intake: 'completed', scan: 'in-flight' }),
    });
    expect(screen.queryByLabelText('Subreddits (without r/)')).toBeNull();
  });

  it('does not render review screen while scan is in-flight', () => {
    renderPanel({
      state: makeState({ intake: 'completed', scan: 'in-flight' }),
    });
    // review approve action should not appear
    expect(screen.queryByText('Save opportunities')).toBeNull();
    expect(screen.queryByText(/Save \d+ opportunit/)).toBeNull();
  });
});
