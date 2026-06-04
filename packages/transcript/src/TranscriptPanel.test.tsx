/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import type { TranscriptPanelProps } from './TranscriptPanel';

afterEach(cleanup);

// framer-motion is not compatible with Happy DOM; replace motion.div with a plain div.
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
}));

describe('TranscriptPanel types', () => {
  it('accepts transcript as required string prop', () => {
    const props: TranscriptPanelProps = { transcript: 'Sample text' };
    expect(props.transcript).toBe('Sample text');
  });

  it('accepts undefined transcript', () => {
    const props: TranscriptPanelProps = { transcript: undefined };
    expect(props.transcript).toBeUndefined();
  });

  it('allows empty string transcript', () => {
    const props: TranscriptPanelProps = { transcript: '' };
    expect(props.transcript).toBe('');
  });
});

describe('TranscriptPanel rendering', () => {
  it('renders transcript text when populated', () => {
    const { TranscriptPanel } = require('./TranscriptPanel');
    render(React.createElement(TranscriptPanel, { transcript: 'Hello world' }));
    expect(screen.getByText('Hello world')).toBeDefined();
  });

  it('renders the empty fallback when transcript is undefined', () => {
    const { TranscriptPanel } = require('./TranscriptPanel');
    render(React.createElement(TranscriptPanel, { transcript: undefined }));
    expect(screen.getByText('Transcript not available')).toBeDefined();
  });

  it('renders skeletons while loading', () => {
    const { TranscriptPanel } = require('./TranscriptPanel');
    const { container } = render(
      React.createElement(TranscriptPanel, { transcript: undefined, isLoading: true })
    );
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});
