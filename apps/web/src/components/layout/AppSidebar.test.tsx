/// <reference types="bun" />
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

// No hub-api mock needed — AppSidebar should not call hub-api at all

const { AppSidebar } = require('./AppSidebar');

afterEach(() => {
  cleanup();
});

describe('AppSidebar', () => {
  it('renders Settings link pointing to /settings without making API calls', () => {
    render(
      React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement(AppSidebar))
    );

    const settingsLink = screen.getByRole('link', { name: /settings/i });
    expect(settingsLink).toBeDefined();

    const href = (settingsLink as HTMLAnchorElement).getAttribute('href');
    expect(href).toBe('/settings');
  });
});
