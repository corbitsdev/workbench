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

describe('gamma-presentation-creator Panel', () => {
  it('renders brief content resolved from template and source step outputs', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ template: 'completed', source: 'completed', generate: 'in-flight' })}
        connected
        stepOutputs={{
          template: { templateId: 'deck-pro', audience: 'Investors', tone: 'Confident', goal: 'Close round' },
          source: { callTitle: 'Acme discovery call' },
        }}
        onSignal={noop}
        onClose={noop}
      />
    );

    expect(screen.getByText('deck-pro')).toBeTruthy();
    expect(screen.getByText('Investors')).toBeTruthy();
    expect(screen.getByText('Confident')).toBeTruthy();
    expect(screen.getByText('Close round')).toBeTruthy();
    expect(screen.getByText('Acme discovery call')).toBeTruthy();
  });

  it('marks completed steps done and the awaiting-signal review step current', () => {
    const { container } = render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: 'completed',
          source: 'completed',
          generate: 'completed',
          review: 'awaiting-signal',
        })}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />
    );

    const indicators = Array.from(container.querySelectorAll('.rounded-full'));
    const labels = indicators.map((el) => el.textContent);
    // template, source, generate completed -> checkmarks; review (4th) current -> number 4
    expect(labels.slice(0, 3)).toEqual(['✓', '✓', '✓']);
    expect(labels[3]).toBe('4');
    expect(screen.getByText('Review the draft')).toBeTruthy();
  });

  it('fires onSignal review-approval when Approve is clicked during awaiting-signal review', async () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          template: 'completed',
          source: 'completed',
          generate: 'completed',
          review: 'awaiting-signal',
        })}
        connected
        stepOutputs={{}}
        onSignal={onSignal}
        onClose={noop}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(onSignal).toHaveBeenCalledWith('review-approval', { approved: true });
  });

  it('does not show Approve when review is not awaiting a signal', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState({ template: 'completed', source: 'in-flight' })}
        connected
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />
    );

    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('renders the https Gamma deck once render completes', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          {
            template: 'completed',
            source: 'completed',
            generate: 'completed',
            review: 'completed',
            render: 'completed',
          },
          'completed'
        )}
        connected
        stepOutputs={{ render: { gammaUrl: 'https://gamma.app/docs/deck-123' } }}
        onSignal={noop}
        onClose={noop}
      />
    );

    const frame = screen.getByTitle('Generated Gamma presentation');
    expect(frame.getAttribute('src')).toBe('https://gamma.app/docs/deck-123');
    expect(screen.getByRole('link', { name: 'Open in Gamma' }).getAttribute('href')).toBe(
      'https://gamma.app/docs/deck-123'
    );
  });

  it('rejects a non-https deck url', () => {
    render(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          {
            template: 'completed',
            source: 'completed',
            generate: 'completed',
            review: 'completed',
            render: 'completed',
          },
          'completed'
        )}
        connected
        stepOutputs={{ render: { gammaUrl: 'http://insecure.example/deck' } }}
        onSignal={noop}
        onClose={noop}
      />
    );

    expect(screen.queryByTitle('Generated Gamma presentation')).toBeNull();
    expect(screen.getByText('Presentation URL is invalid or unavailable.')).toBeTruthy();
  });
});
