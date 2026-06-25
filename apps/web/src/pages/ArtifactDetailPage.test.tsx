/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

let artifactsResult: {
  data?: { id: string; kind: string; title: string }[];
  isLoading: boolean;
  isError: boolean;
};

type CreatedThread = { id: string; instanceId: string; label: string };
let createdThread: CreatedThread;
const createMutate = mock((_arg: undefined, opts?: { onSuccess?: (t: CreatedThread) => void }) => {
  opts?.onSuccess?.(createdThread);
});
const generateTitleMutate = mock((_args: { id: string; firstMessage: string }) => {});
const openThreadInDock = mock((_id: string) => {});

mock.module('../lib/active-workbench-context', () => ({
  useActiveWorkbench: () => ({ activeTenantId: 'tenant-1' }),
}));
mock.module('../hooks/use-myra-threads', () => ({
  useCreateMyraThread: () => ({ mutate: createMutate, isPending: false }),
  useGenerateMyraThreadTitle: () => ({ mutate: generateTitleMutate }),
  isDefaultThreadLabel: (label: string) => /^Chat( \d+)?$/.test(label.trim()),
  writeLastActiveThreadId: () => {},
}));
mock.module('../lib/chat-launcher-context', () => ({
  useChatLauncher: () => ({ openThreadInDock }),
}));
// A controllable session double so a test can drive the phase transition that
// triggers the seeded first-message handoff and observe the real send call.
// Defaults to a ready, no-op session so the existing render tests are unaffected.
const sessionSubscribers = new Set<() => void>();
const sessionController = {
  phase: 'ready',
  send: (_text: string) => {},
  setPhase(next: string) {
    this.phase = next;
    sessionSubscribers.forEach((notify) => notify());
  },
};
mock.module('../hooks/use-myra-session', () => ({
  useMyraSession: () => {
    const [, force] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      sessionSubscribers.add(force);
      return () => {
        sessionSubscribers.delete(force);
      };
    }, []);
    return {
      state: { phase: sessionController.phase },
      messages: [],
      send: (text: string) => sessionController.send(text),
    };
  },
}));
mock.module('../components/MyraChatSurface', () => ({
  MyraChatSurface: (props: { threadLabel?: string }) =>
    React.createElement('div', { 'data-testid': 'chat-surface' }, props.threadLabel ?? ''),
}));
mock.module('@workbench/client/react', () => ({
  useArtifacts: () => artifactsResult,
  useTenantMembers: () => ({ data: [] }),
}));
mock.module('../components/ArtifactBody', () => ({
  default: (props: { artifact: { title: string } }) =>
    React.createElement('div', { 'data-testid': 'body' }, props.artifact.title),
}));

const { ArtifactDetailPage } = require('./ArtifactDetailPage');

function renderAt(id: string) {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [`/artifacts/${id}`] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: '/artifacts/:artifactId',
          element: React.createElement(ArtifactDetailPage),
        }),
        React.createElement(Route, {
          key: 'chat',
          path: '/chats/:threadId',
          element: React.createElement('div', {
            'data-testid': 'fullscreen-chat',
          }),
        })
      )
    )
  );
}

function sendMessage(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/ask myra about this artifact/i), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: /start chat/i }));
}

beforeEach(() => {
  createMutate.mockClear();
  generateTitleMutate.mockClear();
  openThreadInDock.mockClear();
  sessionSubscribers.clear();
  sessionController.phase = 'ready';
  sessionController.send = () => {};
  createdThread = { id: 'thr-1', instanceId: 'inst-1', label: 'Chat' };
  artifactsResult = {
    data: [{ id: 'art-1', kind: 'one-pager', title: 'Acme One-Pager' }],
    isLoading: false,
    isError: false,
  };
});
afterEach(() => cleanup());

describe('ArtifactDetailPage', () => {
  it('renders the artifact full-page', () => {
    renderAt('art-1');
    expect(screen.getByRole('heading', { name: 'Acme One-Pager' })).toBeDefined();
    expect(screen.getByTestId('body').textContent).toBe('Acme One-Pager');
  });

  it('shows a not-found state for an unknown id', () => {
    renderAt('does-not-exist');
    expect(screen.getByText(/couldn't be found/i)).toBeDefined();
  });

  it('does not start a chat with an empty composer', () => {
    renderAt('art-1');
    fireEvent.click(screen.getByRole('button', { name: /start chat/i }));
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('renders the live chat in the pane after the first message', () => {
    renderAt('art-1');
    sendMessage('What is the key value prop?');
    expect(createMutate).toHaveBeenCalledTimes(1);
    // The composer is replaced by the live chat surface, in place.
    expect(screen.getByTestId('chat-surface')).toBeDefined();
    expect(screen.queryByPlaceholderText(/ask myra about this artifact/i)).toBeNull();
  });

  it('auto-titles the new default-labelled thread from the user message', () => {
    renderAt('art-1');
    sendMessage('What is the key value prop?');
    expect(generateTitleMutate).toHaveBeenCalledTimes(1);
    expect(generateTitleMutate.mock.calls[0]?.[0]).toEqual({
      id: 'thr-1',
      firstMessage: 'What is the key value prop?',
    });
  });

  it('does not auto-title a thread that already has a custom label', () => {
    createdThread = {
      id: 'thr-1',
      instanceId: 'inst-1',
      label: 'My deck review',
    };
    renderAt('art-1');
    sendMessage('Hello');
    expect(generateTitleMutate).not.toHaveBeenCalled();
  });

  it('opens the live chat full screen via the Open in menu', () => {
    renderAt('art-1');
    sendMessage('Hello');
    fireEvent.click(screen.getByRole('button', { name: /open in/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /full screen/i }));
    expect(screen.getByTestId('fullscreen-chat')).toBeDefined();
  });

  it('hands the thread to the global dock and collapses the pane', () => {
    renderAt('art-1');
    sendMessage('Hello');
    fireEvent.click(screen.getByRole('button', { name: /open in/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /dock/i }));
    expect(openThreadInDock).toHaveBeenCalledWith('thr-1');
    // Pane returns to the composer; the in-pane surface is gone.
    expect(screen.queryByTestId('chat-surface')).toBeNull();
    expect(screen.getByPlaceholderText(/ask myra about this artifact/i)).toBeDefined();
  });

  it('delivers the seeded first message exactly once, only after the session is ready', () => {
    // Drive the real pending-first-message handoff end to end: the page seeds the
    // pending message on thread creation, and the in-pane session must deliver it
    // once it reaches `ready` — never before, and never twice.
    const sent: string[] = [];
    sessionController.send = (text: string) => sent.push(text);
    // Session is still connecting when the thread is created.
    sessionController.phase = 'connecting';

    renderAt('art-1');
    sendMessage('What is the value prop?');

    // Thread exists but the session is not ready: nothing delivered yet.
    expect(sent).toEqual([]);

    // Session reaches ready -> the seeded message is delivered exactly once,
    // carrying both the artifact context and the user's text.
    act(() => sessionController.setPhase('ready'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('art-1');
    expect(sent[0]).toContain('What is the value prop?');

    // A later phase churn (ready -> reconnecting -> ready) must not re-deliver:
    // the pending message was consumed on first read.
    act(() => sessionController.setPhase('reconnecting'));
    act(() => sessionController.setPhase('ready'));
    expect(sent).toHaveLength(1);
  });
});
