/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import ProgressChecklist from './ProgressChecklist';

afterEach(cleanup);

// framer-motion is not compatible with Happy DOM; replace motion.div with a plain div
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
}));

describe('ProgressChecklist', () => {
  it('renders default analysis tasks in idle state', () => {
    render(<ProgressChecklist status="idle" />);
    expect(screen.getByText('Reading transcript turns and speaker roles')).toBeDefined();
    expect(screen.getByText(/Click "Run analysis"/)).toBeDefined();
  });

  it('renders custom tasks and a running hint when running', () => {
    render(<ProgressChecklist tasks={['Task A', 'Task B']} status="running" />);
    expect(screen.getByText('Task A')).toBeDefined();
    expect(screen.getByText('Task B')).toBeDefined();
    expect(screen.getByText(/Analyzing transcript/)).toBeDefined();
  });

  it('shows an error message when status is error', () => {
    render(<ProgressChecklist status="error" />);
    expect(screen.getByText(/Analysis failed/)).toBeDefined();
  });

  it('renders an empty-state message when there are no tasks', () => {
    render(<ProgressChecklist tasks={[]} />);
    expect(screen.getByText('No tasks to display')).toBeDefined();
  });

  it('renders completed tasks with checkmarks when status is completed', () => {
    render(<ProgressChecklist tasks={['Task A', 'Task B']} status="completed" />);
    expect(screen.getByText('Task A')).toBeDefined();
    expect(screen.getByText('Task B')).toBeDefined();
    expect(screen.getAllByText('✓').length).toBe(2);
  });
});
