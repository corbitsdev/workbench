/// <reference types="bun" />
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
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
    expect(screen.getByText('Hello agent')).toBeDefined();
  });

  it('renders agent message with markdown support', () => {
    const message: ChatMessage = {
      id: '2',
      role: 'agent',
      content: '# Hello\n\nThis is **bold** text.',
      createdAt: '2026-06-04T00:01:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByText('bold')).toBeDefined();
  });

  it('renders system message with markdown support', () => {
    const message: ChatMessage = {
      id: '3',
      role: 'system',
      content: 'System **notice**',
      createdAt: '2026-06-04T00:02:00Z',
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText('notice')).toBeDefined();
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
    expect(screen.getByText('Failed to send')).toBeDefined();
  });
});
