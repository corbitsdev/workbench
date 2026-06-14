/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';

function makeArtifact(overrides: Partial<ArtifactWithSession>): ArtifactWithSession {
  return {
    id: 'a-1',
    sessionId: 'wf-1',
    parentId: null,
    painPointId: null,
    kind: 'pain-points',
    title: 'Acme Pain Points',
    content: 'body',
    status: 'approved',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionName: 'Acme Corp',
    sessionStatus: 'done',
    ...overrides,
  };
}

let mockArtifactsResult: {
  data: ArtifactWithSession[] | undefined;
  isLoading: boolean;
  isError: boolean;
} = { data: [makeArtifact({})], isLoading: false, isError: false };

mock.module('@workbench/client/react', () => ({
  useArtifacts: () => mockArtifactsResult,
  useLibraryResources: () => ({ data: [], isLoading: false, isError: false }),
}));

afterEach(cleanup);

function renderPicker(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(React.createElement(QueryClientProvider, { client }, ui));
}

describe('ArtifactSourcePicker', () => {
  it('selecting an artifact and continuing reports source: artifact with its id', async () => {
    mockArtifactsResult = { data: [makeArtifact({})], isLoading: false, isError: false };
    const onSelect = mock(() => {});
    const { default: ArtifactSourcePicker } = await import('./ArtifactSourcePicker');
    renderPicker(React.createElement(ArtifactSourcePicker, { onSelect }));

    fireEvent.click(screen.getByText('Acme Pain Points'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toEqual({
      source: 'artifact',
      sourceArtifactId: 'a-1',
      callTitle: 'Acme Pain Points',
    });
  });

  it('does not report until an artifact is selected', async () => {
    mockArtifactsResult = { data: [makeArtifact({})], isLoading: false, isError: false };
    const onSelect = mock(() => {});
    const { default: ArtifactSourcePicker } = await import('./ArtifactSourcePicker');
    renderPicker(React.createElement(ArtifactSourcePicker, { onSelect }));

    const continueButton = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(continueButton);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('restricts to the provided kinds', async () => {
    mockArtifactsResult = {
      data: [
        makeArtifact({ id: 'a-1', kind: 'pain-points', title: 'Pains' }),
        makeArtifact({ id: 'a-2', kind: 'email', title: 'An Email' }),
      ],
      isLoading: false,
      isError: false,
    };
    const onSelect = mock(() => {});
    const { default: ArtifactSourcePicker } = await import('./ArtifactSourcePicker');
    renderPicker(React.createElement(ArtifactSourcePicker, { onSelect, kinds: ['pain-points'] }));

    expect(screen.queryByText('Pains')).not.toBeNull();
    expect(screen.queryByText('An Email')).toBeNull();
  });

  it('shows an empty state when there are no eligible artifacts', async () => {
    mockArtifactsResult = { data: [], isLoading: false, isError: false };
    const onSelect = mock(() => {});
    const { default: ArtifactSourcePicker } = await import('./ArtifactSourcePicker');
    renderPicker(React.createElement(ArtifactSourcePicker, { onSelect }));

    expect(screen.queryByText(/no artifacts available/i)).not.toBeNull();
  });
});
