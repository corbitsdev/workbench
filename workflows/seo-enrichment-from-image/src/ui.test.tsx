import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { RunState, StepPhase, StepState } from '@intx/workflow';
import { Panel } from './ui';

afterEach(cleanup);

function stepState(stepId: string, phase: StepPhase): StepState {
  return { stepId, phase, currentAttempt: 1 };
}

function makeState(phases: Partial<Record<string, StepPhase>>): RunState {
  const steps = new Map<string, StepState>();
  for (const [id, phase] of Object.entries(phases)) {
    if (phase) steps.set(id, stepState(id, phase));
  }
  return {
    runId: 'run_1',
    phase: 'running',
    lastSeq: 0,
    steps,
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  };
}

const enrichOutput = {
  rows: [
    {
      id: 'r1',
      name: 'Widget',
      variants: {
        titles: ['Title A', 'Title B'],
        descriptions: ['Desc A', 'Desc B'],
        summaries: ['Sum A', 'Sum B'],
      },
    },
  ],
};

describe('Panel', () => {
  it('renders the header and step labels', () => {
    render(
      <Panel
        deploymentId="d1"
        state={makeState({ intake: 'completed', enrich: 'in-flight' })}
        connected
        stepOutputs={{}}
        onSignal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('SEO Enrichment from Image')).toBeTruthy();
    expect(screen.getByText('Enrich')).toBeTruthy();
  });

  it('renders parsed intake rows', () => {
    render(
      <Panel
        deploymentId="d1"
        state={makeState({ intake: 'completed' })}
        connected
        stepOutputs={{ intake: { rows: [{ id: 'r1', name: 'Widget', targetUrl: 'https://x.test' }] } }}
        onSignal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Widget')).toBeTruthy();
    expect(screen.getByText('https://x.test')).toBeTruthy();
  });

  it('renders the five-variant style enrichment options', () => {
    render(
      <Panel
        deploymentId="d1"
        state={makeState({ enrich: 'completed' })}
        connected
        stepOutputs={{ enrich: enrichOutput }}
        onSignal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Title A')).toBeTruthy();
    expect(screen.getByText('Desc B')).toBeTruthy();
  });

  it('shows a failed state with the error message', () => {
    const state = makeState({ enrich: 'failed' });
    const enrich = state.steps.get('enrich');
    if (enrich) enrich.lastError = { message: 'enrichment exploded' };
    render(
      <Panel
        deploymentId="d1"
        state={state}
        connected
        stepOutputs={{}}
        onSignal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('This workflow run failed.')).toBeTruthy();
    expect(screen.getByText('enrichment exploded')).toBeTruthy();
  });

  it('fires onClose when the close button is clicked', () => {
    const onClose = mock(() => {});
    render(
      <Panel
        deploymentId="d1"
        state={makeState({})}
        connected
        stepOutputs={{}}
        onSignal={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByLabelText('Close panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('emits row-selection with the chosen selections when confirmed', () => {
    const onSignal = mock((_name: string, _payload?: unknown) => {});
    render(
      <Panel
        deploymentId="d1"
        state={makeState({ enrich: 'completed', review: 'awaiting-signal' })}
        connected
        stepOutputs={{ enrich: enrichOutput }}
        onSignal={onSignal}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText('Widget Title option 1'));
    fireEvent.click(screen.getByLabelText('Widget Description option 2'));
    fireEvent.click(screen.getByLabelText('Widget Summary option 1'));

    const confirm = screen.getByRole('button', { name: 'Confirm selections' });
    fireEvent.click(confirm);

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith('row-selection', {
      selections: [
        {
          id: 'r1',
          name: 'Widget',
          title: 'Title A',
          description: 'Desc B',
          summary: 'Sum A',
        },
      ],
    });
  });

  it('keeps confirm disabled until every field is chosen', () => {
    const onSignal = mock(() => {});
    render(
      <Panel
        deploymentId="d1"
        state={makeState({ enrich: 'completed', review: 'awaiting-signal' })}
        connected
        stepOutputs={{ enrich: enrichOutput }}
        onSignal={onSignal}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText('Widget Title option 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm selections' }));
    expect(onSignal).not.toHaveBeenCalled();
  });

  it('renders the export CSV and download link', () => {
    render(
      <Panel
        deploymentId="d1"
        state={makeState({ export: 'completed' })}
        connected
        stepOutputs={{ export: { filename: 'seo.csv', csv: 'a,b\n1,2', downloadUrl: 'blob:x' } }}
        onSignal={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Download/)).toBeTruthy();
    expect(screen.getByText((content) => content.includes('a,b'))).toBeTruthy();
  });
});
