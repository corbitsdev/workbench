/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

let artifactsResult: {
  data?: { id: string; kind: string; title: string }[];
  isLoading: boolean;
  isError: boolean;
};
const createMutate = mock(
  (_arg: undefined, _opts?: { onSuccess?: (t: { id: string }) => void }) => {}
);

mock.module('../lib/active-workbench-context', () => ({
  useActiveWorkbench: () => ({ activeTenantId: 'tenant-1' }),
}));
mock.module('../hooks/use-myra-threads', () => ({
  useCreateMyraThread: () => ({ mutate: createMutate, isPending: false }),
  writeLastActiveThreadId: () => {},
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
        })
      )
    )
  );
}

beforeEach(() => {
  createMutate.mockClear();
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

  it('starts a new thread when a message is sent', () => {
    renderAt('art-1');
    fireEvent.change(screen.getByPlaceholderText(/ask myra about this artifact/i), {
      target: { value: 'What is the key value prop?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start chat/i }));
    expect(createMutate).toHaveBeenCalledTimes(1);
  });
});
