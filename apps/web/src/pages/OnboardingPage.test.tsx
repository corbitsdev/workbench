/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
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

const mockCreateTenantCredential = mock(() =>
  Promise.resolve({ credentialId: 'cred-1', providerId: 'prov-1' })
);
const mockLaunchInstanceSession = mock(() => Promise.resolve({ launched: true }));

// Bun's mock.module statically reads the returned object's literal keys to build
// the synthetic module's named exports, and validates every import of hub-api
// across the test scope — so all exports must be listed literally here, not
// spread (see commit 75d448f).
mock.module('../lib/hub-api', () => ({
  getMe: mock(() =>
    Promise.resolve({
      userId: 'user-1',
      userName: 'User',
      personalTenantId: 'tnt-1',
      paInstanceId: 'ins-1',
      provisioned: true,
    })
  ),
  getMyPrincipals: mock(() => Promise.resolve([])),
  createTenant: mock(() => Promise.resolve({ id: '', name: '', slug: '', domain: '' })),
  createWorkbench: mock(() => Promise.resolve({ id: '', name: '', slug: '', tenantId: '' })),
  listWorkbenches: mock(() => Promise.resolve([])),
  getTenant: mock(() =>
    Promise.resolve({
      id: '',
      name: '',
      slug: '',
      domain: '',
      parentId: null,
      createdAt: '',
      updatedAt: '',
    })
  ),
  listTenantPrincipals: mock(() => Promise.resolve([])),
  getPrincipal: mock(() =>
    Promise.resolve({
      id: '',
      tenantId: '',
      kind: 'user',
      refId: '',
      displayName: '',
      status: 'active',
      roles: [],
      createdAt: '',
      updatedAt: '',
    })
  ),
  listTenantCredentials: mock(() => Promise.resolve([])),
  listPrincipalGrants: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
  createTenantCredential: mockCreateTenantCredential,
  deleteTenantCredential: mock(() => Promise.resolve()),
  launchInstanceSession: mockLaunchInstanceSession,
  assignCredentialToAgent: mock(() => Promise.resolve()),
  provisionAgent: mock(() =>
    Promise.resolve({ instanceId: '', agentId: '', agentName: '', tenantId: '' })
  ),
  listEnrichedCredentials: mock(() => Promise.resolve([])),
}));

import { OnboardingPage } from './OnboardingPage';

// On success the page does a full reload (window.location.assign) so the
// persistent Myra chat panel remounts against the live session.
const mockAssign = mock(() => {});
Object.defineProperty(window, 'location', {
  configurable: true,
  value: { assign: mockAssign },
});

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
  mockCreateTenantCredential.mockClear();
  mockLaunchInstanceSession.mockClear();
  mockAssign.mockClear();
});

function renderPage() {
  return render(React.createElement(MemoryRouter, null, React.createElement(OnboardingPage)));
}

describe('OnboardingPage', () => {
  it('renders the provider select, api key field, and submit button', () => {
    renderPage();
    expect(screen.getByLabelText(/provider/i)).toBeDefined();
    expect(screen.getByLabelText(/api key/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDefined();
  });

  it('submit is disabled until an api key is entered', () => {
    renderPage();
    const btn = screen.getByRole('button', { name: /finish setup/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables submit once an api key is typed', () => {
    renderPage();
    const input = screen.getByLabelText(/api key/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-test' } });
    const btn = screen.getByRole('button', { name: /finish setup/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('creates the credential, launches the session, and reloads on success', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /finish setup/i }).closest('form')!);
    });
    expect(mockCreateTenantCredential).toHaveBeenCalledTimes(1);
    expect(mockLaunchInstanceSession).toHaveBeenCalledTimes(1);
    expect(mockAssign).toHaveBeenCalledWith('/');
  });

  it('shows an error message when credential setup fails', async () => {
    mockCreateTenantCredential.mockImplementationOnce(() =>
      Promise.reject(new Error('Invalid API key'))
    );
    renderPage();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-bad' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /finish setup/i }).closest('form')!);
    });
    const error = await screen.findByRole('alert');
    expect(error).toBeDefined();
  });

  it('skip for now navigates to /', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
