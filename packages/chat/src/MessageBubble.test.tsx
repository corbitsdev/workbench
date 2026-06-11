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
});
