/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { TranscriptReview } from './TranscriptReview';
import type { TranscriptReviewProps } from './TranscriptReview';
import type { SelectedPainPointContext, StructuredTranscript } from './types';

afterEach(cleanup);

// framer-motion is not Happy DOM compatible; TranscriptReview does not use it,
// but TranscriptPanel (re-exported from the same barrel) does, so stub it.
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
}));

const transcript: StructuredTranscript = {
  metadata: { source: 'paste', companyName: 'Acme', title: 'Acme — Discovery' },
  speakers: [
    { id: 's1', name: 'Dana', role: 'rep' },
    { id: 's2', name: 'Pat', role: 'prospect' },
  ],
  turns: [
    { id: 't1', speakerId: 's1', text: 'Tell me about your deploys.', startSeconds: 5 },
    { id: 't2', speakerId: 's2', text: 'We spend too much time deploying.', startSeconds: 42 },
  ],
};

describe('TranscriptReview types', () => {
  it('accepts a fully structured transcript with selected pain points', () => {
    const selected: SelectedPainPointContext[] = [
      { id: 'p1', severity: 'high', context: 'Slow deploys', quote: 'too much time deploying' },
    ];
    const props: TranscriptReviewProps = { transcript, selectedPainPoints: selected };
    expect(props.transcript?.turns.length).toBe(2);
    expect(props.selectedPainPoints?.[0]?.severity).toBe('high');
  });

  it('accepts an undefined transcript for the empty state', () => {
    const props: TranscriptReviewProps = { transcript: undefined };
    expect(props.transcript).toBeUndefined();
  });
});

describe('TranscriptReview rendering', () => {
  it('renders populated turns with speaker names', () => {
    render(React.createElement(TranscriptReview, { transcript }));
    expect(screen.getByText('Tell me about your deploys.')).toBeDefined();
    expect(screen.getByText('We spend too much time deploying.')).toBeDefined();
    expect(screen.getByText('Dana')).toBeDefined();
    expect(screen.getByText('Pat')).toBeDefined();
  });

  it('renders the company title in the header', () => {
    render(React.createElement(TranscriptReview, { transcript }));
    expect(screen.getByText('Acme — Discovery')).toBeDefined();
  });

  it('renders the empty state when transcript is undefined', () => {
    render(React.createElement(TranscriptReview, { transcript: undefined }));
    expect(screen.getByText('Transcript not available')).toBeDefined();
  });

  it('renders the empty state when there are no turns', () => {
    const empty: StructuredTranscript = { ...transcript, turns: [] };
    render(React.createElement(TranscriptReview, { transcript: empty }));
    expect(screen.getByText('Transcript not available')).toBeDefined();
  });

  it('renders the loading state and hides turns', () => {
    const { container } = render(
      React.createElement(TranscriptReview, { transcript, isLoading: true })
    );
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('Tell me about your deploys.')).toBeNull();
  });

  it('highlights a turn matching a selected pain point quote', () => {
    const selected: SelectedPainPointContext[] = [
      { id: 'p1', severity: 'high', context: 'Slow deploys', quote: 'too much time deploying' },
    ];
    render(React.createElement(TranscriptReview, { transcript, selectedPainPoints: selected }));
    const highlighted = screen.getByText('We spend too much time deploying.');
    // The highlight ring lives on the wrapping button.
    expect(highlighted.closest('button')?.className).toContain('ring-orange');
  });

  it('keeps a stable scroll container for long transcripts', () => {
    const longTurns = Array.from({ length: 500 }, (_, i) => ({
      id: `t${i}`,
      speakerId: 's1',
      text: `Turn number ${i}`,
    }));
    const long: StructuredTranscript = { ...transcript, turns: longTurns };
    const { container } = render(React.createElement(TranscriptReview, { transcript: long }));
    // Exactly one dedicated scroll region; header is outside it.
    const scrollers = container.querySelectorAll('.overflow-y-auto');
    expect(scrollers.length).toBe(1);
    expect(screen.getByText('Turn number 499')).toBeDefined();
  });

  it('uses theme tokens rather than hardcoded colors (dark/light aware)', () => {
    const { container } = render(React.createElement(TranscriptReview, { transcript }));
    const root = container.firstElementChild as HTMLElement;
    // Token classes resolve per active theme via CSS variables.
    expect(root.className).toContain('bg-surface');
    expect(root.className).toContain('text-text');
  });

  it('calls onSelectTurn when a turn is clicked', () => {
    const onSelectTurn = mock((_id: string) => {});
    render(React.createElement(TranscriptReview, { transcript, onSelectTurn }));
    const button = screen.getByText('Tell me about your deploys.').closest('button');
    button?.click();
    expect(onSelectTurn).toHaveBeenCalledTimes(1);
    expect(onSelectTurn).toHaveBeenCalledWith('t1');
  });
});
