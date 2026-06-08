/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// framer-motion stub — avoids animation side-effects in tests.
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// CredentialField makes its own network calls; stub it down to a marker.
mock.module('../CredentialField', () => ({
  CredentialField: ({ label, onChange }: { label: string; onChange: (id: string) => void }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': `credential-field-${label}`,
        onClick: () => onChange('cred-1'),
      },
      label
    ),
}));

mock.module('../../lib/hub-api', () => ({
  INFERENCE_PROVIDER_NAMES: ['anthropic', 'openai', 'google-genai', 'openai-compatible'],
  listAvailableTools: () =>
    Promise.resolve([
      { name: 'exa_search', description: 'Web search', providerName: 'exa' },
      { name: 'granola_list_notes', description: 'List notes', providerName: 'granola' },
      { name: 'granola_get_note', description: 'Get note', providerName: 'granola' },
    ]),
  provisionAgent: mock(),
  updateAgentTools: mock(),
}));

import { NewAgentModal } from './NewAgentModal';
import { provisionAgent } from '../../lib/hub-api';

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(NewAgentModal, {
        open: true,
        onClose: mock(),
        onCreated: mock(),
        workbenchTenantId: 't-1',
      })
    )
  );
}

afterEach(() => cleanup());

describe('NewAgentModal', () => {
  it('collapses tools by provider until the provider is expanded', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    await waitFor(() => expect(view.getByRole('button', { name: /Granola/ })).toBeDefined());

    expect(view.queryByText('Granola List Notes')).toBeNull();

    await user.click(view.getAllByRole('button', { name: /Granola/ })[0]!);

    expect(view.getByText('Granola List Notes')).toBeDefined();
    expect(view.getByText('Granola Get Note')).toBeDefined();
  });

  it('locks required tools inside expanded providers', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    await waitFor(() => expect(view.getByRole('button', { name: /Granola/ })).toBeDefined());
    await user.click(view.getByText('Oat — Call Intelligence'));
    await user.click(view.getAllByRole('button', { name: /Granola/ })[0]!);

    const listNotes = view
      .getByText('Granola List Notes')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(listNotes.checked).toBe(true);
    expect(listNotes.disabled).toBe(true);

    await user.click(listNotes);
    expect(listNotes.checked).toBe(true);
  });

  it('sends selected tools with the initial create request', async () => {
    const provisionAgentMock = provisionAgent as ReturnType<typeof mock>;
    provisionAgentMock.mockResolvedValue({
      instanceId: 'ins-1',
      agentId: 'agt-1',
      agentName: 'Custom',
      tenantId: 't-1',
      launched: true,
    });

    const user = userEvent.setup();
    const view = renderModal();

    await waitFor(() => expect(view.getByRole('button', { name: /Exa/ })).toBeDefined());
    await user.type(view.getByLabelText('Name'), 'Custom');
    await user.type(view.getByLabelText('System prompt'), 'Do useful work');
    await user.click(view.getByTestId('credential-field-Inference Provider'));
    await user.click(view.getByRole('button', { name: /Exa/ }));
    await user.click(view.getByText('Exa Search'));
    await user.click(view.getByRole('button', { name: 'Deploy agent' }));

    await waitFor(() => expect(provisionAgentMock).toHaveBeenCalled());
    expect(provisionAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ tools: ['exa_search'] })
    );
  });

  it('leaves optional tools toggleable inside expanded providers', async () => {
    const user = userEvent.setup();
    const view = renderModal();

    await waitFor(() => expect(view.getByRole('button', { name: /Exa/ })).toBeDefined());
    await user.click(view.getByRole('button', { name: /Exa/ }));

    const exa = view
      .getByText('Exa Search')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(exa.disabled).toBe(false);
    expect(exa.checked).toBe(false);
    await user.click(exa);
    expect(exa.checked).toBe(true);
  });
});
