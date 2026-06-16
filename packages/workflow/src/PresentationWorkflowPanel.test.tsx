/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
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
  gammaUrl,
}: { status?: string; gammaUrl?: string } = {}): PresentationWorkflowView {
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
      generate: {
        completed: status === 'done',
        dispatched:
          status === 'generating' ||
          status === 'reviewing' ||
          status === 'rendering' ||
          status === 'done',
        gammaUrl,
      },
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

  it('shows a generating state while the pipeline is running', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'generating' })} onClose={() => {}} />
    );
    expect(screen.getByText('Generating content from brief')).not.toBeNull();
  });

  it('shows a reviewing state during the review round', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'reviewing' })} onClose={() => {}} />
    );
    expect(screen.getByText('Reviewing against brand guidelines')).not.toBeNull();
  });

  it('shows a rendering state during Gamma render', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'rendering' })} onClose={() => {}} />
    );
    expect(screen.getByText('Rendering in Gamma')).not.toBeNull();
  });

  it('shows a done state when the deck is generated', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'done' })} onClose={() => {}} />
    );
    expect(screen.getByText('Deck ready')).not.toBeNull();
  });

  it('shows an Open in Gamma link when done and gammaUrl is provided', () => {
    render(
      <PresentationWorkflowPanel
        workflow={makeView({ status: 'done', gammaUrl: 'https://gamma.app/deck/abc' })}
        gammaUrl="https://gamma.app/deck/abc"
        onClose={() => {}}
      />
    );
    const link = screen.getByText('Open in Gamma');
    expect(link).not.toBeNull();
  });

  it('shows a failure state without going blank', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'failed' })} onClose={() => {}} />
    );
    expect(screen.getByText('Generation failed')).not.toBeNull();
  });

  it('shows the actual error message in the failure panel when provided', () => {
    render(
      <PresentationWorkflowPanel
        workflow={{
          ...makeView({ status: 'failed' }),
          errorMessage: 'Generate step returned empty content',
        }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Generate step returned empty content')).not.toBeNull();
  });

  it('shows a generic fallback in the failure panel when no errorMessage is provided', () => {
    render(
      <PresentationWorkflowPanel workflow={makeView({ status: 'failed' })} onClose={() => {}} />
    );
    expect(screen.getByText('The deck could not be generated. Try again.')).not.toBeNull();
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
});
