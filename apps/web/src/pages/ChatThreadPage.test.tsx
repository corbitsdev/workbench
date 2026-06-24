/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

type ThreadsResult = {
  data?: { id: string; instanceId: string; label: string; createdAt: string }[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};

let threadsResult: ThreadsResult = {
  data: [{ id: 't1', instanceId: 'i1', label: 'First', createdAt: '2026-01-01T00:00:00Z' }],
  isLoading: false,
  isError: false,
  refetch: () => {},
};
const createMutate = mock((_arg: undefined, _opts?: unknown) => {});

mock.module('../hooks/use-myra-threads', () => ({
  useMyraThreads: () => threadsResult,
  useCreateMyraThread: () => ({ mutate: createMutate, isPending: false }),
  writeLastActiveThreadId: () => {},
  resolveActiveThread: (threads: ThreadsResult['data'], explicit?: string | null) => {
    if (!threads || threads.length === 0) return null;
    if (explicit) {
      const m = threads.find((t) => t.id === explicit);
      if (m) return m;
    }
    return threads[0];
  },
}));

mock.module('../hooks/use-myra-session', () => ({
  useMyraSession: () => ({ state: { phase: 'loading' }, messages: [], activity: null }),
}));

mock.module('../components/MyraChatSurface', () => ({
  MyraChatSurface: (props: { threadLabel?: string }) =>
    React.createElement('div', { 'data-testid': 'surface' }, props.threadLabel ?? ''),
}));

mock.module('../components/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const { ChatThreadPage } = require('./ChatThreadPage');

function renderAt(path: string) {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/chats/:threadId',
          element: React.createElement(ChatThreadPage),
        }),
        React.createElement(Route, { path: '/chats', element: React.createElement(ChatThreadPage) })
      )
    )
  );
}

beforeEach(() => {
  createMutate.mockClear();
  threadsResult = {
    data: [{ id: 't1', instanceId: 'i1', label: 'First', createdAt: '2026-01-01T00:00:00Z' }],
    isLoading: false,
    isError: false,
    refetch: () => {},
  };
});

afterEach(() => cleanup());

describe('ChatThreadPage', () => {
  it('shows a loading state while threads load', () => {
    threadsResult = { data: undefined, isLoading: true, isError: false, refetch: () => {} };
    renderAt('/chats/t1');
    expect(screen.getByText(/loading your chats/i)).toBeDefined();
  });

  it('renders the chat surface for a valid thread', () => {
    renderAt('/chats/t1');
    expect(screen.getByTestId('surface').textContent).toBe('First');
  });

  it('canonicalizes an unknown thread id to the resolved thread', () => {
    renderAt('/chats/unknown');
    // resolveActiveThread falls back to t1; the page redirects then renders it.
    expect(screen.getByTestId('surface').textContent).toBe('First');
  });

  it('offers a create action when there are no threads', () => {
    threadsResult = { data: [], isLoading: false, isError: false, refetch: () => {} };
    renderAt('/chats');
    const button = screen.getByRole('button', { name: /start a chat/i });
    fireEvent.click(button);
    expect(createMutate).toHaveBeenCalledTimes(1);
  });
});
