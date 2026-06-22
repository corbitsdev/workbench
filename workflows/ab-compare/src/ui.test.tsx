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

function makeState(
  phases: Partial<Record<string, Phase>>,
  runPhase: RunState['phase'] = 'running'
): RunState {
  const steps = new Map<string, StepState>();
  for (const [stepId, phase] of Object.entries(phases)) {
    if (!phase) continue;
    steps.set(stepId, {
      stepId,
      phase,
      currentAttempt: 1,
    } as unknown as StepState);
  }
  return {
    phase: runPhase,
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
    signalPending: false,
    onSignal,
    onClose,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

// ── Header and stepper ────────────────────────────────────────────────────────

describe('ab-compare Panel — header', () => {
  it('renders the panel header and all step labels in the stepper', () => {
    renderPanel();
    screen.getByText('A/B Compare');
    for (const label of ['Input', 'Execute', 'Compare', 'Review', 'Persist']) {
      screen.getByText(label);
    }
  });

  it('renders a close button', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── Guided step routing ───────────────────────────────────────────────────────

describe('ab-compare Panel — guided routing (ONLY active step shown)', () => {
  it('shows the input screen when input is awaiting-signal', () => {
    renderPanel({ state: makeState({ input: 'awaiting-signal' }) });
    screen.getByText('Shared prompt');
    // execute screen must NOT be visible
    expect(screen.queryByText('Running the prompt across variants…')).toBeNull();
  });

  it('shows the execute screen while execute is in-flight', () => {
    renderPanel({
      state: makeState({ input: 'completed', execute: 'in-flight' }),
    });
    screen.getByText('Running the prompt across variants…');
    // input form gone
    expect(screen.queryByText('Shared prompt')).toBeNull();
  });

  it('shows the compare screen while compare is in-flight', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'in-flight',
      }),
    });
    screen.getByText('Generating blind ranking…');
  });

  it('shows the review screen when review is awaiting-signal', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: {
        compare: { reply: 'VariantAlpha ranked first', turn: null },
      },
    });
    screen.getByText('Approve comparison');
    // The review screen embeds the compare output above the approval gate.
    screen.getByText('VariantAlpha ranked first');
  });

  it('shows the persist screen when persist is in-flight', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'completed',
        persist: 'in-flight',
      }),
    });
    screen.getByText('Saving artifact…');
  });

  it('shows the persist screen (final) when all steps are completed', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'completed',
        persist: 'completed',
      }),
      stepOutputs: {
        persist: {
          callId: 'det-1',
          content: JSON.stringify({
            artifactId: 'art_1',
            title: 'A/B Comparison Results',
            kind: 'document',
            version: 1,
          }),
        },
      },
    });
    screen.getByText('Comparison saved');
    screen.getByText('A/B Comparison Results');
  });
});

// ── Input screen ─────────────────────────────────────────────────────────────

describe('ab-compare Panel — input screen', () => {
  it('shows a prompt textarea and a start button', () => {
    renderPanel({ state: makeState({ input: 'awaiting-signal' }) });
    screen.getByPlaceholderText('The prompt to run against each variant');
    screen.getByText('Start comparison');
  });

  it('start button is disabled until a prompt is entered', () => {
    renderPanel({ state: makeState({ input: 'awaiting-signal' }) });
    const button = screen.getByText('Start comparison') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('fires onSignal with { prompt } when the form is submitted', () => {
    const { onSignal } = renderPanel({
      state: makeState({ input: 'awaiting-signal' }),
    });
    fireEvent.change(screen.getByPlaceholderText('The prompt to run against each variant'), {
      target: { value: 'Rewrite for clarity' },
    });
    fireEvent.click(screen.getByText('Start comparison'));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['input', { prompt: 'Rewrite for clarity' }]);
  });

  it('trims whitespace from the prompt before submitting', () => {
    const { onSignal } = renderPanel({
      state: makeState({ input: 'awaiting-signal' }),
    });
    fireEvent.change(screen.getByPlaceholderText('The prompt to run against each variant'), {
      target: { value: '  hello  ' },
    });
    fireEvent.click(screen.getByText('Start comparison'));
    expect(onSignal.mock.calls[0]).toEqual(['input', { prompt: 'hello' }]);
  });

  it('disables submission while disconnected', () => {
    const { onSignal } = renderPanel({
      state: makeState({ input: 'awaiting-signal' }),
      connected: false,
    });
    fireEvent.change(screen.getByPlaceholderText('The prompt to run against each variant'), {
      target: { value: 'some prompt' },
    });
    const button = screen.getByText('Start comparison') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it('disables submission while a signal is pending', () => {
    const { onSignal } = renderPanel({
      state: makeState({ input: 'awaiting-signal' }),
      signalPending: true,
    });
    fireEvent.change(screen.getByPlaceholderText('The prompt to run against each variant'), {
      target: { value: 'some prompt' },
    });
    const button = screen.getByText('Start comparison') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });
});

// ── Execute screen ────────────────────────────────────────────────────────────

describe('ab-compare Panel — execute screen', () => {
  it('shows a loading state while execute is in-flight', () => {
    renderPanel({
      state: makeState({ input: 'completed', execute: 'in-flight' }),
    });
    screen.getByText('Running the prompt across variants…');
    // input form must not be visible
    expect(screen.queryByText('Shared prompt')).toBeNull();
  });

  it('renders execute reply once completed and compare not yet started', () => {
    // In the guided flow: execute=completed and compare=in-flight (just started)
    // means current===compare, so ExecuteScreen is no longer shown.
    // Test the boundary: execute=in-flight shows loader; execute=completed+
    // compare=in-flight shows compare screen.
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'in-flight',
      }),
    });
    // Now showing compare screen (loading), not execute screen
    screen.getByText('Generating blind ranking…');
    expect(screen.queryByText('Running the prompt across variants…')).toBeNull();
  });
});

// ── Compare screen ────────────────────────────────────────────────────────────
// The compare screen is shown while compare is in-flight (loading state).
// Once compare completes, the guided flow moves to the review screen, which
// embeds the compare output above the approval gate.

describe('ab-compare Panel — compare screen', () => {
  it('shows a loading state while compare is in-flight', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'in-flight',
      }),
    });
    screen.getByText('Generating blind ranking…');
    expect(screen.queryByText('Approve comparison')).toBeNull();
  });
});

// ── Compare output rendered via review screen ─────────────────────────────────
// The review screen is the consumer of compare output in the guided flow.
// These tests verify that structured JSON and plain-text fallback both render.

describe('ab-compare Panel — compare output (via review screen)', () => {
  it('renders structured ranking when compareAgent emits strict JSON', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: {
        compare: {
          reply: JSON.stringify({
            summary: 'B reads cleaner.',
            ranking: [
              { rank: 1, label: 'Variant B', rationale: 'tighter hook' },
              { rank: 2, label: 'Variant A', rationale: 'wordy' },
            ],
          }),
          turn: null,
        },
      },
    });
    screen.getByText('B reads cleaner.');
    screen.getByText('Variant B');
    screen.getByText('tighter hook');
    screen.getByText('Variant A');
    screen.getByText('wordy');
  });

  it('falls back to plain-text reply when compareAgent does not emit strict JSON', () => {
    const reply = 'VariantB best. VariantA verbose.';
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: { compare: { reply, turn: null } },
    });
    screen.getByText(reply);
  });

  it('renders the plain-text fallback reply as parsed markdown', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: { compare: { reply: 'Variant **B** wins', turn: null } },
    });
    const strong = screen.getByText('B');
    expect(strong.tagName).toBe('STRONG');
    expect(screen.queryByText('Variant **B** wins')).toBeNull();
  });

  it('shows an error when compare output fails validation', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: { compare: { notReply: true } },
    });
    screen.getByText("Couldn't read the comparison output.");
  });
});

// ── Review screen ─────────────────────────────────────────────────────────────

describe('ab-compare Panel — review screen', () => {
  it('fires onSignal with { approved: true } when Approve is clicked', () => {
    const { onSignal } = renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: { compare: { reply: 'ranked', turn: null } },
    });
    fireEvent.click(screen.getByText('Approve comparison'));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['comparison-review', { approved: true }]);
  });

  it('disables Approve while disconnected', () => {
    const { onSignal } = renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      connected: false,
      stepOutputs: { compare: { reply: 'ranked', turn: null } },
    });
    const button = screen.getByText('Approve comparison') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it('disables Approve while a signal is pending', () => {
    const { onSignal } = renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      signalPending: true,
      stepOutputs: { compare: { reply: 'ranked', turn: null } },
    });
    const button = screen.getByText('Approve comparison') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onSignal).toHaveBeenCalledTimes(0);
  });

  it('does not show the review screen before compare completes', () => {
    renderPanel({
      state: makeState({ input: 'completed', execute: 'completed' }),
    });
    expect(screen.queryByText('Approve comparison')).toBeNull();
  });
});

// ── Persist screen ────────────────────────────────────────────────────────────

describe('ab-compare Panel — persist screen', () => {
  it('renders the saved artifact from the deterministic tool envelope', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'completed',
        persist: 'completed',
      }),
      stepOutputs: {
        persist: {
          callId: 'det-persist',
          content: JSON.stringify({
            artifactId: 'art_1',
            title: 'A/B Comparison Results',
            kind: 'document',
            version: 1,
          }),
        },
      },
    });
    screen.getByText('A/B Comparison Results');
    screen.getByText('document');
  });

  it('shows a fallback message when artifact envelope is missing', () => {
    renderPanel({
      state: makeState({
        input: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'completed',
        persist: 'completed',
      }),
      stepOutputs: { persist: { notCallId: true } },
    });
    screen.getByText("Couldn't read the saved artifact.");
  });
});

// ── Failure state ─────────────────────────────────────────────────────────────

describe('ab-compare Panel — failure state', () => {
  it('shows a failure message when the run failed', () => {
    renderPanel({
      state: { phase: 'failed', steps: new Map() } as unknown as RunState,
    });
    screen.getByText(/This run failed/);
  });
});
