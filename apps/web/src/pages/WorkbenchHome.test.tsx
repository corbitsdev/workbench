/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import WorkbenchHome from './WorkbenchHome';

// Force the mobile layout by stubbing matchMedia so the min-width query never
// matches. Stubbing the DOM (rather than mock.module) keeps this test isolated
// from sibling files — cross-file module mocks leak under bun.
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  window.matchMedia = originalMatchMedia;
});

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MemoryRouter, null, React.createElement(WorkbenchHome))
    )
  );
}

describe('WorkbenchHome mobile layout', () => {
  it('hides the library rail until the open button is pressed', () => {
    renderHome();
    expect(screen.queryByLabelText('Search workflows, agents')).toBeNull();
    expect(screen.getByRole('button', { name: /open library/i })).toBeDefined();
  });

  it('opens the full-screen library overlay and closes it again', async () => {
    const user = userEvent.setup();
    renderHome();

    await user.click(screen.getByRole('button', { name: /open library/i }));
    expect(screen.getByLabelText('Search workflows, agents')).toBeDefined();

    await user.click(screen.getByRole('button', { name: /close library/i }));
    expect(screen.queryByLabelText('Search workflows, agents')).toBeNull();
  });
});
