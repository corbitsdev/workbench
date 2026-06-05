/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollateralGenerationWorkflow, OutputState } from '@workbench/shared';

// framer-motion is not compatible with Happy DOM
mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const mockGetArtifacts = mock(() => Promise.resolve({ artifacts: [] }));
const mockCreateCollateralGeneration = mock(() =>
  Promise.resolve({ id: 'wf-test-1', status: 'pending' })
);
const mockGetCollateralGeneration = mock<() => Promise<CollateralGenerationWorkflow>>();

mock.module('../lib/collateral-api', () => ({
  getArtifacts: mockGetArtifacts,
  createCollateralGeneration: mockCreateCollateralGeneration,
  getCollateralGeneration: mockGetCollateralGeneration,
  OUTPUT_TYPES: ['case-study', 'one-pager', 'email-draft'],
  OUTPUT_TYPE_LABELS: {
    'case-study': 'Case Study',
    'one-pager': 'One-Pager',
    'email-draft': 'Email Draft',
  },
}));

function renderPanel(props: { onClose?: () => void; onComplete?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { CollateralGenerationPanel } = require('./CollateralGenerationPanel');
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(CollateralGenerationPanel, {
        onClose: props.onClose ?? (() => {}),
        onComplete: props.onComplete ?? (() => {}),
      })
    )
  );
}

function makeWorkflow(
  outputStates: Record<string, Partial<OutputState> & Pick<OutputState, 'status'>>,
  overallStatus: CollateralGenerationWorkflow['status'] = 'done'
): CollateralGenerationWorkflow {
  return {
    id: 'wf-test-1',
    status: overallStatus,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inputArtifactIds: [],
    outputTypes: ['case-study', 'one-pager', 'email-draft'],
    outputs: outputStates as CollateralGenerationWorkflow['outputs'],
  };
}

afterEach(() => {
  cleanup();
  mockGetArtifacts.mockClear();
  mockCreateCollateralGeneration.mockClear();
  mockGetCollateralGeneration.mockClear();
});

describe('CollateralGenerationPanel — results step mixed-state', () => {
  beforeEach(() => {
    // First call (after create): still pending. Second call onwards: mixed done/failed.
    mockGetCollateralGeneration
      .mockResolvedValueOnce(
        makeWorkflow(
          {
            'case-study': { status: 'pending' },
            'one-pager': { status: 'pending' },
            'email-draft': { status: 'pending' },
          },
          'pending'
        )
      )
      .mockResolvedValue(
        makeWorkflow({
          'case-study': { status: 'done', artifactId: 'art-1', title: 'Acme Case Study' },
          'one-pager': { status: 'failed' },
          'email-draft': { status: 'done', artifactId: 'art-2', title: 'Acme Email' },
        })
      );
  });

  it('shows a mixed-state summary when some outputs succeed and some fail', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(
      () => {
        expect(screen.getByText(/2 of 3 outputs generated/i)).toBeDefined();
      },
      { timeout: 10000 }
    );
  });

  it('labels each output with its individual status', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(
      () => {
        expect(screen.getByText('Acme Case Study')).toBeDefined();
      },
      { timeout: 10000 }
    );

    expect(screen.getByText('Acme Email')).toBeDefined();
    const failedBadges = screen.getAllByText('failed');
    expect(failedBadges.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show a global generation failed message on partial results', async () => {
    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(
      () => {
        expect(screen.getByText(/2 of 3 outputs generated/i)).toBeDefined();
      },
      { timeout: 10000 }
    );

    expect(screen.queryByText(/generation failed/i)).toBeNull();
  });
});

describe('CollateralGenerationPanel — gallery refresh callback', () => {
  it('calls onComplete when the workflow reaches done status', async () => {
    mockGetCollateralGeneration
      .mockResolvedValueOnce(
        makeWorkflow(
          {
            'case-study': { status: 'pending' },
            'one-pager': { status: 'pending' },
            'email-draft': { status: 'pending' },
          },
          'pending'
        )
      )
      .mockResolvedValue(
        makeWorkflow({
          'case-study': { status: 'done', artifactId: 'art-1', title: 'Test' },
          'one-pager': { status: 'done', artifactId: 'art-2', title: 'Test 2' },
          'email-draft': { status: 'done', artifactId: 'art-3', title: 'Test 3' },
        })
      );

    const onComplete = mock(() => {});
    renderPanel({ onComplete });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      },
      { timeout: 10000 }
    );
  });

  it('calls onComplete when the workflow reaches failed status', async () => {
    mockGetCollateralGeneration
      .mockResolvedValueOnce(
        makeWorkflow(
          {
            'case-study': { status: 'pending' },
            'one-pager': { status: 'pending' },
            'email-draft': { status: 'pending' },
          },
          'pending'
        )
      )
      .mockResolvedValue(
        makeWorkflow(
          {
            'case-study': { status: 'failed' },
            'one-pager': { status: 'failed' },
            'email-draft': { status: 'failed' },
          },
          'failed'
        )
      );

    const onComplete = mock(() => {});
    renderPanel({ onComplete });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /generate/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole('button', { name: /generate/i }));

    await waitFor(
      () => {
        expect(onComplete).toHaveBeenCalledTimes(1);
      },
      { timeout: 10000 }
    );
  });
});
