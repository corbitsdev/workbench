/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import {
  PresentationWorkflowPanel,
  type PresentationWorkflowView,
} from './PresentationWorkflowPanel';

afterEach(cleanup);

mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
}));

function makeView({
  status = 'ready',
  dispatched = false,
}: { status?: string; dispatched?: boolean } = {}): PresentationWorkflowView {
  return {
    status,
    companyName: 'Acme',
    steps: {
      template: {
        completed: true,
        templateId: 'auto',
        audience: 'Enterprise CTOs',
        tone: 'Formal',
        goal: 'Close the deal',
      },
      source: { completed: true, callTitle: 'Acme discovery call' },
      generate: { completed: status === 'done', dispatched },
    },
  };
}

describe('PresentationWorkflowPanel', () => {
  it('never renders an empty body — shows an awaiting-generation state when ready', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'ready' })} onClose={() => {}} />
    );
    expect(screen.getByText('Awaiting generation')).not.toBeNull();
    // Brief fields from input are surfaced.
    expect(screen.getByText('Enterprise CTOs')).not.toBeNull();
    expect(screen.getByText('Close the deal')).not.toBeNull();
  });

  it('shows a dispatched terminal state while generating', () => {
    render(
      <PresentationWorkflowPanel
        workflow={makeView({ status: 'generating', dispatched: true })}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Brief dispatched to Geralt')).not.toBeNull();
  });

  it('shows a done state when the deck is generated', () => {
    render(
      <PresentationWorkflowPanel
        workflow={makeView({ status: 'done', dispatched: true })}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Presentation generated')).not.toBeNull();
  });

  it('shows a failure state without going blank', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'failed' })} onClose={() => {}} />
    );
    expect(screen.getByText('Generation failed')).not.toBeNull();
  });

  it('renders an error state rather than nothing when the run cannot load', () => {
    render(<PresentationWorkflowPanel workflow={null} isError onClose={() => {}} />);
    expect(screen.getByText('Could not load this presentation.')).not.toBeNull();
  });

  it('renders a body even with no step data', () => {
    render(
      <PresentationWorkflowPanel
        workflow={{ status: 'pending', companyName: null, steps: {} }}
        onClose={() => {}}
      />
    );
    // No brief rows, but the awaiting state still renders — never empty.
    expect(screen.getByText('Awaiting generation')).not.toBeNull();
  });

  it('offers an Open Geralt session button that targets the provided instance', () => {
    const onOpenAgent = mock(() => {});
    render(
      <PresentationWorkflowPanel
        workflow={makeView({ status: 'generating' })}
        geraltInstanceId="inst-9"
        onOpenAgent={onOpenAgent}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByText('Open Geralt session'));
    expect(onOpenAgent).toHaveBeenCalledWith('inst-9');
  });

  it('hides the open-session button when no Geralt instance is available', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'generating' })} onClose={() => {}} />
    );
    expect(screen.queryByText('Open Geralt session')).toBeNull();
  });
});
