/// <reference types="bun" />
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { CollapsedGroup } from './CollapsedGroup';
import { type CollapsedGroupItem } from './compactMessages';
import { type ChatMessage } from './types';

afterEach(() => {
  cleanup();
});

function makeGroup(count: number): CollapsedGroupItem {
  const messages: ChatMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    role: 'agent' as const,
    content: `Tool message ${i + 1}`,
    createdAt: '2026-06-06T00:00:00Z',
    kind: 'tool' as const,
  }));
  return {
    type: 'collapsed_group',
    id: messages[0]?.id ?? 'group',
    count,
    messages,
  };
}

describe('CollapsedGroup', () => {
  it('renders a collapsed summary button by default', () => {
    render(<CollapsedGroup group={makeGroup(3)} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toContain('3 tool messages');
    // Messages are not yet visible
    expect(screen.queryByText('Tool message 1')).toBeNull();
  });

  it('shows singular label for one message', () => {
    render(<CollapsedGroup group={makeGroup(1)} />);
    expect(screen.getByRole('button').textContent).toContain('1 tool message');
  });

  it('expands to show messages on click', async () => {
    const user = userEvent.setup();
    render(<CollapsedGroup group={makeGroup(3)} />);

    await user.click(screen.getByRole('button'));

    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Tool message 1')).toBeDefined();
    expect(screen.getByText('Tool message 2')).toBeDefined();
    expect(screen.getByText('Tool message 3')).toBeDefined();
  });

  it('collapses again on second click', async () => {
    const user = userEvent.setup();
    render(<CollapsedGroup group={makeGroup(2)} />);

    const button = screen.getByRole('button');
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Tool message 1')).toBeNull();
  });
});
