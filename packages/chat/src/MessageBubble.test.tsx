/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import { MessageBubble } from './MessageBubble';
import { type ChatMessage } from './types';

afterEach(() => {
  cleanup();
});

describe('MessageBubble', () => {
  it('renders user message as plain text', () => {
    const message: ChatMessage = {
      id: '1',
      role: 'user',
      content: 'Hello agent',
      createdAt: '2026-06-04T00:00:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Hello agent')).not.toBeNull();
  });

  it('renders a reasoning disclosure when the agent message carries reasoning', () => {
    const message: ChatMessage = {
      id: 'r1',
      role: 'agent',
      content: 'Final answer',
      reasoning: 'I weighed the options',
      createdAt: '2026-06-04T00:01:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Reasoning')).not.toBeNull();
    expect(screen.getByText('Final answer')).not.toBeNull();
  });

  it('shows streaming reasoning expanded with the Reasoning label', () => {
    const message: ChatMessage = {
      id: 'r2',
      role: 'agent',
      content: '',
      reasoning: 'Working through it',
      status: 'sending',
      createdAt: '2026-06-04T00:01:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Reasoning')).not.toBeNull();
    expect(screen.getByText('Working through it')).not.toBeNull();
  });

  it('renders agent message with markdown support', () => {
    const message: ChatMessage = {
      id: '2',
      role: 'agent',
      content: '# Hello\n\nThis is **bold** text.',
      createdAt: '2026-06-04T00:01:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Hello')).not.toBeNull();
    expect(screen.getByText('bold')).not.toBeNull();
  });

  it('renders system message with markdown support', () => {
    const message: ChatMessage = {
      id: '3',
      role: 'system',
      content: 'System **notice**',
      createdAt: '2026-06-04T00:02:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('notice')).not.toBeNull();
  });

  it('renders senderLabel when present on an agent-role inbound mail bubble', () => {
    const message: ChatMessage = {
      id: 'mail-1',
      role: 'agent',
      content: 'Please handle this',
      createdAt: '2026-06-05T00:00:00Z',
      senderLabel: 'Myra',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('From: Myra')).not.toBeNull();
  });

  it('does not render a sender label when senderLabel is absent', () => {
    const message: ChatMessage = {
      id: 'mail-2',
      role: 'agent',
      content: 'Regular agent message',
      createdAt: '2026-06-05T00:00:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.queryByText(/^From:/)).toBeNull();
  });

  it('shows failed status when present', () => {
    const message: ChatMessage = {
      id: '4',
      role: 'user',
      content: 'oops',
      createdAt: '2026-06-04T00:03:00Z',
      status: 'failed',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Failed to send')).not.toBeNull();
  });

  it('renders an img element for each base64 image in an agent message', () => {
    const message: ChatMessage = {
      id: 'img1',
      role: 'agent',
      content: 'Here is the screenshot',
      createdAt: '2026-06-04T00:04:00Z',
      images: [{ mimeType: 'image/png', data: 'abc123' }],
    };
    const { container } = render(<MessageBubble message={message} />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('data:image/png;base64,abc123');
  });

  it('renders multiple images when the message has more than one', () => {
    const message: ChatMessage = {
      id: 'img2',
      role: 'agent',
      content: 'Two images',
      createdAt: '2026-06-04T00:05:00Z',
      images: [
        { mimeType: 'image/jpeg', data: 'data1' },
        { mimeType: 'image/png', data: 'data2' },
      ],
    };
    const { container } = render(<MessageBubble message={message} />);
    const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
    expect(imgs.length).toBe(2);
    const [first, second] = imgs;
    expect(first?.src).toContain('data:image/jpeg;base64,data1');
    expect(second?.src).toContain('data:image/png;base64,data2');
  });

  it('lifts a fenced ui block out of agent prose and renders it via the registry', () => {
    const message: ChatMessage = {
      id: 'ui1',
      role: 'agent',
      content: [
        'Here is your call.',
        '```ui',
        '{"kind":"choice","prompt":"Which one?","options":[{"id":"a","label":"ABK Demo"}]}',
        '```',
      ].join('\n'),
      createdAt: '2026-06-04T00:07:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Here is your call.')).not.toBeNull();
    expect(screen.getByText('Which one?')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'ABK Demo' })).not.toBeNull();
  });

  it('forwards onRespond from an embedded choice block to the caller', () => {
    const onRespond = mock(() => undefined);
    const message: ChatMessage = {
      id: 'ui2',
      role: 'agent',
      content: [
        '```ui',
        '{"kind":"choice","options":[{"id":"a","label":"Yes","value":"yes"}]}',
        '```',
      ].join('\n'),
      createdAt: '2026-06-04T00:08:00Z',
    };
    render(<MessageBubble message={message} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onRespond).toHaveBeenCalledWith({ blockKind: 'choice', value: 'yes' });
  });

  it('does not extract a ui block while the agent message is still streaming', () => {
    const message: ChatMessage = {
      id: 'ui3',
      role: 'agent',
      status: 'sending',
      content: [
        '```ui',
        '{"kind":"choice","options":[{"id":"a","label":"Streamed option"}]}',
        '```',
      ].join('\n'),
      createdAt: '2026-06-04T00:09:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.queryByRole('button', { name: 'Streamed option' })).toBeNull();
  });

  it('renders nothing for an empty settled agent message', () => {
    const message: ChatMessage = {
      id: 'empty1',
      role: 'agent',
      content: '',
      createdAt: '2026-06-04T00:10:00Z',
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a settled agent message that is only whitespace', () => {
    const message: ChatMessage = {
      id: 'ws1',
      role: 'agent',
      content: '\n\n   \n',
      createdAt: '2026-06-04T00:10:00Z',
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a broken-image fallback on load error without crashing', () => {
    const message: ChatMessage = {
      id: 'img3',
      role: 'agent',
      content: 'broken',
      createdAt: '2026-06-04T00:06:00Z',
      images: [{ mimeType: 'image/png', data: 'badbytes' }],
    };
    const { container } = render(<MessageBubble message={message} />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Image unavailable')).not.toBeNull();
  });
});
