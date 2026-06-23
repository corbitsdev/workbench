/// <reference types="bun" />
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { mock } from 'bun:test';

mock.module('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_target, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode }) => {
          const {
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

import { DockedChat } from './DockedChat';
import { DockedChatBar, DOCKED_BAR_HEIGHT } from './DockedChatBar';
import { FloatingChat } from './FloatingChat';
import { TypingIndicator } from './TypingIndicator';
import { QuickReplyChips } from './QuickReplyChips';
import { type QuickReply } from './types';

afterEach(() => {
  cleanup();
});

describe('DockedChat', () => {
  it('renders children and defaults to the right side at 360px', () => {
    render(
      <DockedChat>
        <div>panel</div>
      </DockedChat>
    );
    const aside = screen.getByText('panel').parentElement as HTMLElement;
    expect(aside.getAttribute('data-side')).toBe('right');
    expect(aside.style.width).toBe('360px');
  });

  it('docks to the left when side is left', () => {
    render(
      <DockedChat side="left">
        <div>left panel</div>
      </DockedChat>
    );
    const aside = screen.getByText('left panel').parentElement as HTMLElement;
    expect(aside.getAttribute('data-side')).toBe('left');
  });

  it('accepts a string width verbatim', () => {
    render(
      <DockedChat width="50%">
        <div>wide</div>
      </DockedChat>
    );
    const aside = screen.getByText('wide').parentElement as HTMLElement;
    expect(aside.style.width).toBe('50%');
  });
});

describe('DockedChatBar', () => {
  it('renders children inside a labeled complementary region at the fixed height', () => {
    render(
      <DockedChatBar>
        <div>bar content</div>
      </DockedChatBar>
    );
    const region = screen.getByRole('complementary', { name: 'Chat' });
    expect(region).toBeDefined();
    expect(screen.getByText('bar content')).toBeDefined();
    expect(DOCKED_BAR_HEIGHT).toBe(340);
  });
});

describe('FloatingChat', () => {
  it('renders the dialog with children when open', () => {
    render(
      <FloatingChat open>
        <div>floating panel</div>
      </FloatingChat>
    );
    expect(screen.getByRole('dialog', { name: 'Chat' })).toBeDefined();
    expect(screen.getByText('floating panel')).toBeDefined();
  });

  it('renders nothing when closed', () => {
    render(
      <FloatingChat open={false}>
        <div>hidden panel</div>
      </FloatingChat>
    );
    expect(screen.queryByText('hidden panel')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fills the viewport (full-screen overlay) when open', () => {
    render(
      <FloatingChat open>
        <div>full panel</div>
      </FloatingChat>
    );
    const dialog = screen.getByRole('dialog', { name: 'Chat' });
    expect(dialog.className).toContain('fixed');
    expect(dialog.className).toContain('inset-0');
  });

  it('calls onClose when Escape is pressed so a full-screen panel is never a trap', () => {
    const onClose = mock(() => {});
    render(
      <FloatingChat open onClose={onClose}>
        <div>closable panel</div>
      </FloatingChat>
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose.mock.calls.length).toBe(1);
  });

  it('does not call onClose for non-Escape keys', () => {
    const onClose = mock(() => {});
    render(
      <FloatingChat open onClose={onClose}>
        <div>panel</div>
      </FloatingChat>
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onClose.mock.calls.length).toBe(0);
  });
});

describe('TypingIndicator', () => {
  it('renders the dots and an optional label', () => {
    render(<TypingIndicator label="Ada is typing" />);
    expect(screen.getByTestId('typing-indicator')).toBeDefined();
    expect(screen.getByText('Ada is typing')).toBeDefined();
  });

  it('omits the label when none is given', () => {
    render(<TypingIndicator />);
    const indicator = screen.getByTestId('typing-indicator');
    expect(indicator.textContent).toBe('');
  });
});

describe('QuickReplyChips', () => {
  const replies: QuickReply[] = [
    { id: 'a', label: 'Yes', value: 'affirmative' },
    { id: 'b', label: 'No' },
  ];

  it('renders a chip per reply showing its label', () => {
    render(<QuickReplyChips replies={replies} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Yes' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'No' })).toBeDefined();
  });

  it('fires onSelect with the chosen reply', async () => {
    const userEvent = (await import('@testing-library/user-event')).default;
    const user = userEvent.setup();
    const onSelect = mock((_reply: QuickReply) => {});
    render(<QuickReplyChips replies={replies} onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onSelect.mock.calls[0]?.[0]?.id).toBe('a');
  });

  it('renders nothing when there are no replies', () => {
    const { container } = render(<QuickReplyChips replies={[]} onSelect={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
