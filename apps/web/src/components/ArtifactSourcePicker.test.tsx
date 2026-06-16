/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { ArtifactWithSession } from '@workbench/shared';
import ArtifactSourcePicker from './ArtifactSourcePicker';

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
    ownerPrincipalId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionName: 'Acme Corp',
    sessionStatus: 'done',
    ownerName: null,
    ...overrides,
  };
}

const TENANT_ID = 'tenant-workbench';

afterEach(cleanup);

// Seed the real useArtifacts query cache rather than module-mocking
// @workbench/client/react. Under bun, mock.module is applied globally for the
// whole run, so mocking that shared surface poisons the @workbench/client tests
// that import the real useArtifacts.
function renderPicker(
  artifacts: ArtifactWithSession[],
  props: { onSelect: (data: unknown) => void; kinds?: string[]; initialSelectedId?: string }
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['artifacts', TENANT_ID, '', 'newest', '', '', ''], artifacts);
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ArtifactSourcePicker, { tenantId: TENANT_ID, ...props })
    )
  );
}

describe('ArtifactSourcePicker', () => {
  it('selecting an artifact and continuing reports source: artifact with its id', () => {
    const onSelect = mock<(data: unknown) => void>(() => {});
    renderPicker([makeArtifact({})], { onSelect });

    fireEvent.click(screen.getByText('Acme Pain Points'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    const [firstCall] = onSelect.mock.calls;
    if (!firstCall) throw new Error('expected onSelect to be called');
    expect(firstCall[0]).toEqual({
      source: 'artifact',
      sourceArtifactId: 'a-1',
      callTitle: 'Acme Pain Points',
    });
  });

  it('does not report until an artifact is selected', () => {
    const onSelect = mock(() => {});
    renderPicker([makeArtifact({})], { onSelect });

    const continueButton = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    fireEvent.click(continueButton);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('restricts to the provided kinds', () => {
    const onSelect = mock(() => {});
    renderPicker(
      [
        makeArtifact({ id: 'a-1', kind: 'pain-points', title: 'Pains' }),
        makeArtifact({ id: 'a-2', kind: 'email', title: 'An Email' }),
      ],
      { onSelect, kinds: ['pain-points'] }
    );

    expect(screen.queryByText('Pains')).not.toBeNull();
    expect(screen.queryByText('An Email')).toBeNull();
  });

  it('preselects initialSelectedId so the artifact can be confirmed without clicking it (CL-1935)', () => {
    const onSelect = mock<(data: unknown) => void>(() => {});
    renderPicker(
      [makeArtifact({ id: 'a-1', title: 'First' }), makeArtifact({ id: 'a-2', title: 'Seeded' })],
      { onSelect, initialSelectedId: 'a-2' }
    );

    const continueButton = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);

    fireEvent.click(continueButton);
    const [firstCall] = onSelect.mock.calls;
    if (!firstCall) throw new Error('expected onSelect to be called');
    expect(firstCall[0]).toEqual({
      source: 'artifact',
      sourceArtifactId: 'a-2',
      callTitle: 'Seeded',
    });
  });

  it('shows an empty state when there are no eligible artifacts', () => {
    const onSelect = mock(() => {});
    renderPicker([], { onSelect });

    expect(screen.queryByText(/no artifacts available/i)).not.toBeNull();
  });
});
