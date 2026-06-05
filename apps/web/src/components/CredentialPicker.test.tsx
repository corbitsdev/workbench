/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Principal, CredentialDetail } from '../lib/hub-api';

afterEach(() => cleanup());

const principals: Principal[] = [
  {
    id: 'p-1',
    tenantId: 't-1',
    tenantSlug: 'abk-labs',
    tenantName: 'ABK Labs',
    kind: 'user',
    status: 'active',
    roles: [],
  },
  {
    id: 'p-2',
    tenantId: 't-2',
    tenantSlug: 'user-sawyer',
    tenantName: 'Sawyer',
    kind: 'user',
    status: 'active',
    roles: [],
  },
];

const credentialsByTenant: Record<string, CredentialDetail[]> = {
  't-1': [
    {
      id: 'cred-1',
      tenantId: 't-1',
      providerId: 'granola',
      name: 'Granola API Key',
      type: 'api_key',
      status: 'active',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ],
  't-2': [
    {
      id: 'cred-2',
      tenantId: 't-2',
      providerId: 'linear',
      name: 'Linear API Key',
      type: 'api_key',
      status: 'active',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ],
};

describe('CredentialPicker', () => {
  it('renders loading state', async () => {
    const { CredentialPicker } = await import('./CredentialPicker');
    render(
      React.createElement(CredentialPicker, {
        principals: [],
        credentialsByTenant: {},
        selectedIds: [],
        onSelect: () => {},
        isLoading: true,
      })
    );
    expect(screen.getByTestId('credential-picker-loading')).toBeDefined();
  });

  it('renders empty state when no credentials', async () => {
    const { CredentialPicker } = await import('./CredentialPicker');
    render(
      React.createElement(CredentialPicker, {
        principals: [],
        credentialsByTenant: {},
        selectedIds: [],
        onSelect: () => {},
      })
    );
    expect(screen.getByTestId('credential-picker-empty')).toBeDefined();
  });

  it('renders credentials with tenant name in display format', async () => {
    const { CredentialPicker } = await import('./CredentialPicker');
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: [],
        onSelect: () => {},
      })
    );
    expect(screen.getByText('Granola API Key — ABK Labs')).toBeDefined();
    expect(screen.getByText('Linear API Key — Sawyer')).toBeDefined();
  });

  it('calls onSelect with toggled credential IDs when checkbox clicked', async () => {
    const { CredentialPicker } = await import('./CredentialPicker');
    const onSelect = mock((ids: string[]) => ids);
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: [],
        onSelect,
      })
    );
    const checkbox = screen.getByTestId('credential-checkbox-cred-1') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onSelect).toHaveBeenCalledWith(['cred-1']);
  });

  it('reflects checked state from selectedIds', async () => {
    const { CredentialPicker } = await import('./CredentialPicker');
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: ['cred-1'],
        onSelect: () => {},
      })
    );
    const checkbox = screen.getByTestId('credential-checkbox-cred-1') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    const unchecked = screen.getByTestId('credential-checkbox-cred-2') as HTMLInputElement;
    expect(unchecked.checked).toBe(false);
  });

  it('removes credential ID from selection when already checked', async () => {
    const { CredentialPicker } = await import('./CredentialPicker');
    const onSelect = mock((ids: string[]) => ids);
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: ['cred-1'],
        onSelect,
      })
    );
    const checkbox = screen.getByTestId('credential-checkbox-cred-1') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onSelect).toHaveBeenCalledWith([]);
  });
});
