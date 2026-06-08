/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
  CredentialField: ({ label }: { label: string }) =>
    React.createElement('div', { 'data-testid': `credential-field-${label}` }, label),
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
  it('locks required tools and never renders an inline tool-credential block', async () => {
    const user = userEvent.setup();
    renderModal();

    // Tools load asynchronously.
    await waitFor(() => expect(screen.getByText('Granola List Notes')).toBeDefined());

    // Apply the Oat premade — its required tools become locked.
    await user.click(screen.getByText('Oat — Call Intelligence'));

    const listNotes = screen
      .getByText('Granola List Notes')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(listNotes.checked).toBe(true);
    expect(listNotes.disabled).toBe(true);

    // Clicking a required tool must not unselect it.
    await user.click(listNotes);
    expect(listNotes.checked).toBe(true);

    // The old inline raw-entry block must be gone.
    expect(screen.queryByText('Granola credentials')).toBeNull();
    expect(screen.queryByPlaceholderText('https://api.granola.ai')).toBeNull();
  });

  it('leaves optional tools toggleable', async () => {
    const user = userEvent.setup();
    renderModal();

    await waitFor(() => expect(screen.getByText('Exa Search')).toBeDefined());
    await user.click(screen.getByText('Oat — Call Intelligence'));

    const exa = screen
      .getByText('Exa Search')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;

    expect(exa.disabled).toBe(false);
    expect(exa.checked).toBe(false);
    await user.click(exa);
    expect(exa.checked).toBe(true);
  });
});
