/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import type { RunState, StepState } from '@intx/workflow';
import type { WorkflowCredential, WorkflowPanelProps } from '@workbench/ui';

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

const MOCK_CREDENTIALS: WorkflowCredential[] = [
  {
    id: 'cred_anthropic',
    name: 'Anthropic',
    providerName: 'anthropic',
    providerPlugin: 'anthropic',
  },
  {
    id: 'cred_openai',
    name: 'OpenAI',
    providerName: 'openai',
    providerPlugin: 'openai',
  },
  {
    id: 'cred_opencode',
    name: 'OpenCode Zen',
    providerName: 'opencode-zen',
    providerPlugin: 'openai-compatible',
  },
];

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
    credentials: MOCK_CREDENTIALS,
    ...overrides,
  };
  render(<Panel {...props} />);
  return { onSignal, onClose };
}

// Navigate the 3-step config wizard and fire the run signal.
// Step 1: select credentials in dropdowns; Step 2: skip; Step 3: fill input.
async function runConfigWizard(opts: { input?: string; skill?: string } = {}) {
  // Step 1 — Comparisons: select providers for both slots
  const selects = screen.getAllByRole('combobox');
  fireEvent.change(selects[0]!, { target: { value: 'cred_anthropic' } });
  fireEvent.change(selects[1]!, { target: { value: 'cred_openai' } });
  fireEvent.click(screen.getByText('Next'));

  // Step 2 — Configure: optionally set skill
  if (opts.skill !== undefined) {
    const skillInputs = screen.getAllByPlaceholderText('e.g. Hammy humanizer');
    fireEvent.change(skillInputs[0]!, { target: { value: opts.skill } });
  }
  fireEvent.click(screen.getByText('Next'));

  // Step 3 — Input: fill shared text
  fireEvent.change(
    screen.getByPlaceholderText('Paste the prompt you want to run across all providers…'),
    { target: { value: opts.input ?? 'Rewrite for clarity' } }
  );
  fireEvent.click(screen.getByText('Run comparison'));
}

// ── Header and stepper ────────────────────────────────────────────────────────

describe('ab-compare Panel — header', () => {
  it('renders the panel header and all step labels in the stepper', () => {
    renderPanel();
    screen.getByText('A/B Compare');
    for (const label of ['Configure', 'Execute', 'Compare', 'Review', 'Persist']) {
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
  it('shows the config screen when config is awaiting-signal', () => {
    renderPanel({ state: makeState({ config: 'awaiting-signal' }) });
    screen.getByText('Comparisons');
    expect(screen.queryByText('Running the prompt across variants…')).toBeNull();
  });

  it('shows the execute screen while execute is in-flight', () => {
    renderPanel({
      state: makeState({ config: 'completed', execute: 'in-flight' }),
    });
    screen.getByText('Running the prompt across variants…');
    expect(screen.queryByText('Comparisons')).toBeNull();
  });

  it('shows the compare screen while compare is in-flight', () => {
    renderPanel({
      state: makeState({
        config: 'completed',
        execute: 'completed',
        compare: 'in-flight',
      }),
    });
    screen.getByText('Generating blind ranking…');
  });

  it('shows the review screen when review is awaiting-signal', () => {
    renderPanel({
      state: makeState({
        config: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: {
        compare: { reply: 'VariantAlpha ranked first', turn: null },
      },
    });
    screen.getByText('Approve comparison');
    screen.getByText('VariantAlpha ranked first');
  });

  it('shows the persist screen when persist is in-flight', () => {
    renderPanel({
      state: makeState({
        config: 'completed',
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
        config: 'completed',
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

// ── Config screen ──────────────────────────────────────────────────────────────

describe('ab-compare Panel — config screen', () => {
  it('shows two comparison slots and credential dropdowns on step 1', () => {
    renderPanel({ state: makeState({ config: 'awaiting-signal' }) });
    screen.getByText('Comparison 1');
    screen.getByText('Comparison 2');
    // Each slot has a provider dropdown
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it('Next is disabled until at least two slots are filled', () => {
    renderPanel({ state: makeState({ config: 'awaiting-signal' }) });
    const nextBtn = screen.getByText('Next') as HTMLButtonElement;
    // Next is a plain button, not disabled by attribute — clicking it without
    // selection triggers a validation error instead.
    fireEvent.click(nextBtn);
    screen.getByText('Select at least two providers to compare.');
  });

  it('fires onSignal with variants and shared input on submit', async () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: 'awaiting-signal' }),
    });
    await runConfigWizard({ input: 'Rewrite for clarity' });
    expect(onSignal).toHaveBeenCalledTimes(1);
    const [signalName, payload] = onSignal.mock.calls[0]! as [
      string,
      {
        variants: { label: string; providerName: string; model: string; input: string }[];
        input: string;
      },
    ];
    expect(signalName).toBe('ab-config');
    expect(payload.input).toBe('Rewrite for clarity');
    expect(payload.variants.length).toBe(2);
    expect(payload.variants[0]!.providerName).toBe('anthropic');
    expect(payload.variants[0]!.label).toBe('Variant 1');
    expect(payload.variants[1]!.providerName).toBe('openai');
    expect(payload.variants[1]!.label).toBe('Variant 2');
    for (const v of payload.variants) {
      expect(v.input).toBe('Rewrite for clarity');
    }
  });

  it('includes optional skill on a variant when provided on step 2', async () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: 'awaiting-signal' }),
    });
    await runConfigWizard({ skill: 'Hammy' });
    const payload = onSignal.mock.calls[0]![1] as {
      variants: { skill?: string }[];
    };
    expect(payload.variants[0]!.skill).toBe('Hammy');
    expect(payload.variants[1]!.skill).toBeUndefined();
  });

  it('trims whitespace from the shared input before submitting', async () => {
    const { onSignal } = renderPanel({
      state: makeState({ config: 'awaiting-signal' }),
    });
    await runConfigWizard({ input: '  hello  ' });
    const payload = onSignal.mock.calls[0]![1] as { input: string };
    expect(payload.input).toBe('hello');
  });

  it('disables Next and Run while disconnected', () => {
    renderPanel({
      state: makeState({ config: 'awaiting-signal' }),
      connected: false,
    });
    // The Next/Run button is the one with bg-orange class
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    const nextBtn = buttons.find(
      (b) => b.textContent === 'Next' || b.textContent === 'Run comparison'
    );
    expect(nextBtn?.disabled).toBe(true);
  });

  it('disables Next and Run while a signal is pending', () => {
    renderPanel({
      state: makeState({ config: 'awaiting-signal' }),
      signalPending: true,
    });
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
    const nextBtn = buttons.find((b) => b.textContent === 'Starting…');
    expect(nextBtn?.disabled).toBe(true);
  });
});

// ── Execute screen ────────────────────────────────────────────────────────────

describe('ab-compare Panel — execute screen', () => {
  it('shows a loading state while execute is in-flight', () => {
    renderPanel({
      state: makeState({ config: 'completed', execute: 'in-flight' }),
    });
    screen.getByText('Running the prompt across variants…');
    expect(screen.queryByText('Comparison 1')).toBeNull();
  });

  it('renders one anonymous output per variant from the map output array on the review screen', () => {
    renderPanel({
      state: makeState({
        config: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: {
        execute: [{ reply: 'Answer one' }, { reply: 'Answer two' }],
        compare: { reply: 'ranked', turn: null },
      },
    });
    screen.getByText('Answer one');
    screen.getByText('Answer two');
    // Outputs are labeled by position, never by provider/model.
    expect(screen.queryByText('anthropic')).toBeNull();
  });
});

// ── Compare output rendered via review screen ─────────────────────────────────

describe('ab-compare Panel — compare output (via review screen)', () => {
  it('renders structured ranking when the compare agent emits strict JSON', () => {
    renderPanel({
      state: makeState({
        config: 'completed',
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
            recommendation: 'Keep the Variant B hook.',
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
    screen.getByText('Keep the Variant B hook.');
  });

  it('falls back to plain-text reply when the compare agent does not emit strict JSON', () => {
    const reply = 'VariantB best. VariantA verbose.';
    renderPanel({
      state: makeState({
        config: 'completed',
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
        config: 'completed',
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
        config: 'completed',
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
        config: 'completed',
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

  it('fires onSignal with { approved: false } when Skip is clicked', () => {
    const { onSignal } = renderPanel({
      state: makeState({
        config: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'awaiting-signal',
      }),
      stepOutputs: { compare: { reply: 'ranked', turn: null } },
    });
    fireEvent.click(screen.getByText('Skip'));
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['comparison-review', { approved: false }]);
  });

  it('disables Approve while disconnected', () => {
    const { onSignal } = renderPanel({
      state: makeState({
        config: 'completed',
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
        config: 'completed',
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
      state: makeState({ config: 'completed', execute: 'completed' }),
    });
    expect(screen.queryByText('Approve comparison')).toBeNull();
  });
});

// ── Persist screen ────────────────────────────────────────────────────────────

describe('ab-compare Panel — persist screen', () => {
  it('renders the saved artifact from the deterministic tool envelope', () => {
    renderPanel({
      state: makeState({
        config: 'completed',
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
        config: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'completed',
        persist: 'completed',
      }),
      stepOutputs: { persist: { notCallId: true } },
    });
    screen.getByText("Couldn't read the saved artifact.");
  });

  it('reveals provider/model identity for each variant after completion', () => {
    renderPanel({
      state: makeState({
        config: 'completed',
        execute: 'completed',
        compare: 'completed',
        review: 'completed',
        persist: 'completed',
      }),
      stepOutputs: {
        config: {
          variants: [
            {
              label: 'Variant 1',
              providerName: 'anthropic',
              model: 'claude-sonnet-4-6',
              input: 'test',
            },
            { label: 'Variant 2', providerName: 'openai', model: 'gpt-5.4', input: 'test' },
          ],
          input: 'test',
        },
        compare: {
          reply: JSON.stringify({
            ranking: [
              { rank: 1, label: 'Variant 1', rationale: 'clearer' },
              { rank: 2, label: 'Variant 2', rationale: 'verbose' },
            ],
          }),
          turn: null,
        },
        persist: {
          callId: 'det-1',
          content: JSON.stringify({ artifactId: 'art_1', title: 'Results' }),
        },
      },
    });
    screen.getByText('Reveal');
    // Provider names are shown in the reveal section
    screen.getByText(/anthropic/);
    screen.getByText(/openai/);
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
