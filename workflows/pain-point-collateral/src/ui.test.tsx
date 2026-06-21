import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunState } from '@intx/workflow';
import { Panel } from './ui';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StepPhase =
  | 'in-flight'
  | 'awaiting-signal'
  | 'awaiting-timer'
  | 'completed'
  | 'failed'
  | 'cancelled';

function makeState(
  phases: Record<string, StepPhase>,
  runPhase: RunState['phase'] = 'running'
): RunState {
  const steps = new Map<string, { stepId: string; phase: StepPhase; currentAttempt: number }>();
  for (const [stepId, phase] of Object.entries(phases)) {
    steps.set(stepId, { stepId, phase, currentAttempt: 1 });
  }
  return {
    runId: 'run_test',
    phase: runPhase,
    lastSeq: 0,
    steps,
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  } as unknown as RunState;
}

const noop = () => {};

function toolResult(value: unknown): { callId: string; content: string } {
  return { callId: 'c1', content: JSON.stringify(value) };
}

function agentReply(value: unknown): { reply: string } {
  return { reply: JSON.stringify(value) };
}

const NOTE_LIST = toolResult({
  notes: [
    {
      id: 'note_1',
      title: 'Acme discovery call',
      created_at: '2026-01-01',
      summary: 'Onboarding pain.',
    },
    { id: 'note_2', title: 'Beta renewal', created_at: '2026-01-02' },
  ],
});

const PAIN_POINTS = agentReply({
  painPoints: [
    { id: 'pp1', title: 'Slow onboarding', detail: 'Takes weeks to go live.' },
    { id: 'pp2', title: 'No ROI visibility', detail: 'No clear metric to track.' },
  ],
});

const GENERATED_PIECES = [
  agentReply({
    format: 'Email',
    title: 'Cut onboarding time',
    content: 'Dear prospect, cut onboarding from weeks to days.',
  }),
  agentReply({ format: 'One-pager', title: 'ROI at a glance', content: 'Track ROI from day one.' }),
];

// ---------------------------------------------------------------------------
// Transcript step (step 1)
// ---------------------------------------------------------------------------

describe('Panel — transcript selection (step 1)', () => {
  it('renders the note list when intake is complete and select awaits signal', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'completed', select: 'awaiting-signal' })}
        connected
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Acme discovery call');
    screen.getByText('Beta renewal');
    screen.getByText('Onboarding pain.');
  });

  it('fires note-selection signal with correct noteId on note click', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'completed', select: 'awaiting-signal' })}
        connected
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /Acme discovery call/ }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['note-selection', { noteId: 'note_1' }]);
  });

  it('disables note buttons before the select step reaches awaiting-signal', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'completed' })}
        connected
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    const button = screen.getByRole('button', { name: /Acme discovery call/ });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.click(button);
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('shows a loading placeholder while intake is in-flight', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'in-flight' })}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Loading your Granola notes…');
  });

  it('shows a malformed error when note-list content is invalid JSON', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'completed', select: 'awaiting-signal' })}
        connected
        stepOutputs={{ intake: { callId: 'c1', content: 'not-json' } }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText("Couldn't read the Granola note list.");
  });
});

// ---------------------------------------------------------------------------
// Context step (step 2)
// ---------------------------------------------------------------------------

describe('Panel — context input (step 2)', () => {
  it('renders the context textarea when context awaits signal', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'awaiting-signal',
        })}
        connected
        stepOutputs={{
          intake: NOTE_LIST,
          fetch: toolResult({ id: 'note_1', title: 'Acme discovery call', summary: 'Discovery' }),
        }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByPlaceholderText(/focus on integration issues/i);
    screen.getByRole('button', { name: 'Continue' });
  });

  it('fires context signal with trimmed textarea value', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, fetch: toolResult({ id: 'note_1', title: 'Acme' }) }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    await userEvent.type(
      screen.getByPlaceholderText(/focus on integration issues/i),
      'Focus on onboarding cost'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['context', { context: 'Focus on onboarding cost' }]);
  });

  it('allows submitting context with an empty string (optional field)', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, fetch: toolResult({ id: 'note_1', title: 'Acme' }) }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    // No typing — submit empty
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onSignal).toHaveBeenCalledWith('context', { context: '' });
  });
});

// ---------------------------------------------------------------------------
// Pain point selection step (step 3)
// ---------------------------------------------------------------------------

describe('Panel — pain point selection (step 3)', () => {
  it('renders pain points as checkboxes when ppSelection awaits signal', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Slow onboarding');
    screen.getByText('No ROI visibility');
    screen.getByText('Takes weeks to go live.');
  });

  it('fires pain-point-selection signal with correct ids on submit', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    // Check first pain point
    const checkboxes = screen.getAllByRole('checkbox');
    await userEvent.click(checkboxes[0]!);

    // Submit with just pp1 selected
    await userEvent.click(screen.getByRole('button', { name: /Select 1 pain point$/ }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [signalName, payload] = onSignal.mock.calls[0] as [string, { selectedIds: string[] }];
    expect(signalName).toBe('pain-point-selection');
    expect(payload.selectedIds).toContain('pp1');
  });

  it('disables submit when no pain points are selected', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />
    );

    const submitBtn = screen.getByRole('button', { name: /Select pain points/ });
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
  });

  it('shows a placeholder while analyze is in-flight', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'in-flight',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Analyzing transcript for pain points…');
  });

  it('shows a malformed error when analyze output is not valid JSON', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: { reply: '{not valid json' } }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText("Couldn't read the extracted pain points.");
  });
});

// ---------------------------------------------------------------------------
// Format selection step (step 4)
// ---------------------------------------------------------------------------

describe('Panel — format selection (step 4)', () => {
  it('renders format checkboxes when fmtSelection awaits signal', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Email');
    screen.getByText('One-pager');
    screen.getByText('LinkedIn post');
  });

  it('fires format-selection signal with correct {format} objects on submit', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    // Select "Email" and "One-pager"
    await userEvent.click(screen.getByRole('checkbox', { name: 'Email' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'One-pager' }));

    await userEvent.click(screen.getByRole('button', { name: /Generate 2 formats/ }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [signalName, payload] = onSignal.mock.calls[0] as [
      string,
      { formats: { format: string }[] },
    ];
    expect(signalName).toBe('format-selection');
    expect(payload.formats).toEqual(
      expect.arrayContaining([{ format: 'Email' }, { format: 'One-pager' }])
    );
    expect(payload.formats).toHaveLength(2);
  });

  it('disables submit when no formats are selected', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />
    );

    const submitBtn = screen.getByRole('button', { name: /Generate collateral$/ });
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review step (step 5)
// ---------------------------------------------------------------------------

describe('Panel — review generated pieces (step 5)', () => {
  it('renders generated pieces as approve/deny cards when review awaits signal', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'completed',
          generate: 'completed',
          review: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS, generate: GENERATED_PIECES }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Cut onboarding time');
    screen.getByText('ROI at a glance');
    screen.getByText('Dear prospect, cut onboarding from weeks to days.');
    // Both Approve buttons present
    expect(screen.getAllByRole('button', { name: /^Approve / }).length).toBe(2);
  });

  it('fires review signal with only approved pieces when Deny is clicked for one', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'completed',
          generate: 'completed',
          review: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS, generate: GENERATED_PIECES }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    // Deny the second piece (One-pager)
    await userEvent.click(screen.getByRole('button', { name: 'Deny One-pager' }));
    // Save the remaining approved (only Email)
    await userEvent.click(screen.getByRole('button', { name: 'Save 1 artifact' }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [name, payload] = onSignal.mock.calls[0] as [
      string,
      { decisions: { format: string; title: string; content: string }[] },
    ];
    expect(name).toBe('review');
    expect(payload.decisions).toHaveLength(1);
    expect(payload.decisions[0]!.format).toBe('Email');
  });

  it('fires review signal with all pieces when all are approved', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'completed',
          generate: 'completed',
          review: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS, generate: GENERATED_PIECES }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Save 2 artifacts' }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    const [, payload] = onSignal.mock.calls[0] as [string, { decisions: { format: string }[] }];
    expect(payload.decisions).toHaveLength(2);
    expect(payload.decisions.map((d) => d.format)).toEqual(
      expect.arrayContaining(['Email', 'One-pager'])
    );
  });

  it('shows a placeholder while generate is running', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'completed',
          generate: 'in-flight',
        })}
        connected
        stepOutputs={{ intake: NOTE_LIST, analyze: PAIN_POINTS }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Generating collateral…');
  });

  it('shows a malformed error when generated pieces are not valid', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'completed',
          generate: 'completed',
          review: 'awaiting-signal',
        })}
        connected
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: [{ reply: '{bad json' }],
        }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText("Couldn't read the generated collateral.");
  });
});

// ---------------------------------------------------------------------------
// Done step (step 6)
// ---------------------------------------------------------------------------

describe('Panel — done (step 6)', () => {
  it('shows artifact titles when persist is complete', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'completed',
          analyze: 'completed',
          ppSelection: 'completed',
          fmtSelection: 'completed',
          generate: 'completed',
          review: 'completed',
          persist: 'completed',
        })}
        connected
        stepOutputs={{
          intake: NOTE_LIST,
          analyze: PAIN_POINTS,
          generate: GENERATED_PIECES,
          review: {
            decisions: [
              { format: 'Email', title: 'Cut onboarding time', content: 'Hi...' },
              { format: 'One-pager', title: 'ROI at a glance', content: 'Track...' },
            ],
          },
        }}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Cut onboarding time');
    screen.getByText('ROI at a glance');
    screen.getByText('Artifacts created successfully.');
  });
});

// ---------------------------------------------------------------------------
// Error and close
// ---------------------------------------------------------------------------

describe('Panel — error and close', () => {
  it('renders an error banner when a step has failed', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'completed', analyze: 'failed' }, 'failed')}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('This run failed.');
  });

  it('invokes onClose when the header close button is clicked', async () => {
    const onClose = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'in-flight' })}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={onClose}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows disconnected status when connected is false', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'in-flight' })}
        connected={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />
    );

    screen.getByText('Reconnecting…');
  });
});

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

describe('Panel — stepper reflects run progress', () => {
  it('marks steps as completed up to the active one', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          select: 'completed',
          fetch: 'completed',
          context: 'awaiting-signal',
        })}
        connected
        stepOutputs={{
          intake: NOTE_LIST,
          fetch: toolResult({ id: 'note_1', title: 'Acme call' }),
        }}
        onSignal={noop}
        onClose={noop}
      />
    );

    // Context step should be visible (active area renders context form)
    screen.getByPlaceholderText(/focus on integration issues/i);
  });
});
