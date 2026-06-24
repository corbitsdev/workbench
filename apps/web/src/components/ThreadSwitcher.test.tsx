/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { ThreadSwitcher } from './ThreadSwitcher';
import type { MyraThread } from '../lib/hub-api';

const threads: MyraThread[] = [
  { id: 'a', instanceId: 'ia', label: 'Alpha', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'b', instanceId: 'ib', label: 'Beta', createdAt: '2026-01-02T00:00:00Z' },
];

afterEach(() => cleanup());

describe('ThreadSwitcher', () => {
  it('shows the active thread label and switches on select', () => {
    const onSelect = mock((_id: string) => {});
    render(
      React.createElement(ThreadSwitcher, {
        threads,
        activeThreadId: 'a',
        onSelect,
        onNew: () => {},
      })
    );
    // active label visible on the trigger
    expect(screen.getByText('Alpha')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('option', { name: /beta/i }));
    expect(onSelect).toHaveBeenCalledWith('b');
  });

  it('fires onNew from the New chat action', () => {
    let created = 0;
    render(
      React.createElement(ThreadSwitcher, {
        threads,
        activeThreadId: 'a',
        onSelect: () => {},
        onNew: () => {
          created++;
        },
      })
    );
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    fireEvent.click(screen.getByRole('button', { name: /new chat/i }));
    expect(created).toBe(1);
  });
});
