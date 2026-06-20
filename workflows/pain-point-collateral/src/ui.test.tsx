import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RunState } from '@intx/workflow';
import { Panel } from './ui';

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

describe('pain-point-collateral Panel', () => {
  it('renders the selected Granola note, pain points, and generated collateral', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          analyze: 'completed',
          generate: 'completed',
          approval: 'awaiting-signal',
        })}
        connected
        stepOutputs={{
          intake: { title: 'Acme discovery call', summary: 'Buyer frustrated with onboarding time.' },
          analyze: { painPoints: ['Onboarding takes weeks', 'No clear ROI metric'] },
          generate: { collateral: 'One-pager: cut onboarding from weeks to days.' },
        }}
        onSignal={noop}
        onClose={noop}
      />
    );

    expect(screen.getByText('Acme discovery call')).toBeTruthy();
    expect(screen.getByText('Buyer frustrated with onboarding time.')).toBeTruthy();
    expect(screen.getByText('Onboarding takes weeks')).toBeTruthy();
    expect(screen.getByText('No clear ROI metric')).toBeTruthy();
    expect(screen.getByText('One-pager: cut onboarding from weeks to days.')).toBeTruthy();
  });

  it('shows placeholders when a step output has not resolved yet', () => {
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

    expect(screen.getByText('Waiting for a Granola note selection…')).toBeTruthy();
    expect(screen.getByText('Pain points appear here once analysis completes.')).toBeTruthy();
    expect(screen.getByText('Generated collateral appears here once it is ready.')).toBeTruthy();
  });

  it('fires the artifact-approval signal when Approve is clicked', async () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          intake: 'completed',
          analyze: 'completed',
          generate: 'completed',
          approval: 'awaiting-signal',
        })}
        connected
        stepOutputs={{ generate: { collateral: 'Draft collateral' } }}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0]).toEqual(['artifact-approval', { approved: true }]);
  });

  it('does not show Approve until the approval step is awaiting a signal', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: 'completed', analyze: 'completed', generate: 'in-flight' })}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />
    );

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Approval becomes available after collateral is generated.')).toBeTruthy();
  });

  it('renders an error state when a step failed', () => {
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

    expect(screen.getByText('This run failed. Review the step details and start a new run.')).toBeTruthy();
  });

  it('invokes onClose from the header close button', async () => {
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
});
