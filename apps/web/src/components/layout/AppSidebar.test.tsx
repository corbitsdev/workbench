/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';

mock.module('../AuthProvider', () => ({
  useAuth: () => ({
    session: { status: 'authenticated', user: { name: 'Alice' } },
    signOut: () => {},
  }),
}));

mock.module('../../hooks/use-myra-threads', () => ({
  useMyraThreads: () => ({
    data: [{ id: 't1', instanceId: 'i1', label: 'First chat', createdAt: '2026-01-01T00:00:00Z' }],
    isLoading: false,
  }),
  useCreateMyraThread: () => ({ mutate: () => {}, isPending: false }),
  useRenameMyraThread: () => ({ mutate: () => {}, isPending: false }),
  useDeleteMyraThread: () => ({ mutate: () => {}, isPending: false }),
  writeLastActiveThreadId: () => {},
  resolveActiveThread: () => null,
}));

mock.module('../../hooks/use-workbenches', () => ({
  useWorkbenches: () => ({ data: [], isLoading: false }),
}));

const { AppSidebar } = require('./AppSidebar');

afterEach(() => {
  cleanup();
});

function renderSidebar(path = '/') {
  render(
    React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(AppSidebar))
  );
}

describe('AppSidebar', () => {
  it('renders the primary nav and Settings link', () => {
    renderSidebar();
    expect(screen.getByRole('link', { name: /workflows/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /skills/i })).toBeDefined();
    expect(screen.getByRole('link', { name: /insights/i })).toBeDefined();
    const settingsLink = screen.getByRole('link', { name: /settings/i });
    expect((settingsLink as HTMLAnchorElement).getAttribute('href')).toBe('/settings');
  });

  it('renders the New Chat action and the thread list', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: /new chat/i })).toBeDefined();
    expect(screen.getByText('First chat')).toBeDefined();
  });
});
