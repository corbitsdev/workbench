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

const mockSetupMyraCredential = mock(() => Promise.resolve());

mock.module('../lib/hub-api', () => ({
  getMe: mock(() => Promise.resolve({ userId: '', userName: '', personalTenantId: null, paInstanceId: null, provisioned: false })),
  getMyPrincipals: mock(() => Promise.resolve([])),
  createTenant: mock(() => Promise.resolve({ id: '', name: '', slug: '', domain: '' })),
  createWorkspace: mock(() => Promise.resolve({ id: '', name: '', slug: '', tenantId: '' })),
  listWorkbenches: mock(() => Promise.resolve([])),
  getTenant: mock(() => Promise.resolve({ id: '', name: '', slug: '', domain: '', parentId: null, createdAt: '', updatedAt: '' })),
  listTenantPrincipals: mock(() => Promise.resolve([])),
  getPrincipal: mock(() => Promise.resolve({ id: '', tenantId: '', kind: 'user', refId: '', displayName: '', status: 'active', roles: [], createdAt: '', updatedAt: '' })),
  listTenantCredentials: mock(() => Promise.resolve([])),
  listPrincipalGrants: mock(() => Promise.resolve([])),
  listAgentInstances: mock(() => Promise.resolve([])),
  setupMyraCredential: mockSetupMyraCredential,
  provisionAgent: mock(() => Promise.resolve({ instanceId: '', agentId: '', agentName: '', tenantId: '' })),
}));

import { OnboardingPage } from './OnboardingPage';

afterEach(() => {
  cleanup();
  mockNavigate.mockClear();
  mockSetupMyraCredential.mockClear();
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

  it('calls setupMyraCredential and navigates to / on success', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test' } });
    await act(async () => {
      fireEvent.submit(screen.getByRole('button', { name: /finish setup/i }).closest('form')!);
    });
    expect(mockSetupMyraCredential).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('shows an error message when credential setup fails', async () => {
    mockSetupMyraCredential.mockImplementationOnce(() =>
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
