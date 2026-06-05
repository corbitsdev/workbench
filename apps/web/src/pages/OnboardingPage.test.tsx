/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router';

const mockNavigate = mock(() => {});

mock.module('react-router', () => {
  const actual = require('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockCreateWorkspace = mock(() =>
  Promise.resolve({ id: 'ws-1', name: 'Acme Corp', slug: 'acme-corp', tenantId: 'tn-1' })
);

mock.module('../lib/hub-api', () => ({
  getMe: () =>
    Promise.resolve({
      userId: 'u1',
      personalTenantId: 'pt1',
      paInstanceId: null,
      provisioned: true,
    }),
  createWorkspace: mockCreateWorkspace,
  listWorkbenches: () => Promise.resolve([]),
}));

import { OnboardingPage } from './OnboardingPage';

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
  mockCreateWorkspace.mockClear();
});

function renderPage() {
  return render(React.createElement(MemoryRouter, null, React.createElement(OnboardingPage)));
}

describe('OnboardingPage', () => {
  it('renders the workspace name field and submit button', () => {
    renderPage();
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.getByRole('button', { name: /create workspace/i })).toBeDefined();
  });

  it('submits the workspace name and navigates to / on success', async () => {
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByRole('textbox');
    await user.type(input, 'Acme Corp');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));

    expect(mockCreateWorkspace).toHaveBeenCalledWith('Acme Corp');
    // Wait for the async submission to complete and navigate to be called.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows an error message when creation fails', async () => {
    mockCreateWorkspace.mockImplementationOnce(() => Promise.reject(new Error('Server error')));
    const user = userEvent.setup();
    renderPage();

    const input = screen.getByRole('textbox');
    await user.type(input, 'Bad Corp');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));

    const error = await screen.findByRole('alert');
    expect(error).toBeDefined();
  });
});
