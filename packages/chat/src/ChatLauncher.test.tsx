/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

mock.module('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode }) => {
          const {
            drag: _drag,
            dragMomentum: _dm,
            whileTap: _wt,
            initial: _i,
            animate: _a,
            transition: _t,
            ...rest
          } = props as Record<string, unknown>;
          return React.createElement(tag, rest, children);
        },
    }
  ),
}));

import { ChatLauncher } from './ChatLauncher';

afterEach(() => {
  cleanup();
});

describe('ChatLauncher', () => {
  it('fires onClick when pressed', async () => {
    const user = userEvent.setup();
    const onClick = mock(() => {});
    render(<ChatLauncher onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('uses the closed label and unexpanded state by default', () => {
    render(<ChatLauncher onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'Open chat' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('uses the open label and expanded state when open', () => {
    render(<ChatLauncher onClick={() => {}} open />);
    const button = screen.getByRole('button', { name: 'Close chat' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('prefers an explicit label over the open/closed default', () => {
    render(<ChatLauncher onClick={() => {}} label="Talk to Ada" />);
    expect(screen.getByRole('button', { name: 'Talk to Ada' })).toBeDefined();
  });

  it('renders an unread badge when count is positive', () => {
    render(<ChatLauncher onClick={() => {}} unreadCount={3} />);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('hides the unread badge when count is zero', () => {
    render(<ChatLauncher onClick={() => {}} unreadCount={0} />);
    expect(screen.queryByText('0')).toBeNull();
  });
});
