/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import {
  ResourceEnrichmentWorkflowPanel,
  type ResourceEnrichmentWorkflowView,
} from './ResourceEnrichmentWorkflowPanel';

afterEach(cleanup);

mock.module('framer-motion', () => ({
  motion: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
  },
}));

function makeView({
  status = 'ready',
  rowCount = 3,
  selectionCount = 0,
  reviewCompleted = false,
  exportCompleted = false,
}: {
  status?: string;
  rowCount?: number;
  selectionCount?: number;
  reviewCompleted?: boolean;
  exportCompleted?: boolean;
} = {}): ResourceEnrichmentWorkflowView {
  const selections =
    selectionCount > 0
      ? Array.from({ length: selectionCount }, (_, i) => ({
          id: `sel-${i}`,
          title: `product-${i}`,
          content: '{}',
          kind: 'selection',
        }))
      : [];
  const csvArtifacts = exportCompleted
    ? [{ id: 'csv-1', title: 'Enriched resources', content: 'a,b', kind: 'csv-export' }]
    : [];

  return {
    status,
    companyName: null,
    steps: {
      intake: { completed: status !== 'pending', rows: rowCount },
      enrich: { completed: selectionCount > 0, selections },
      review: { completed: reviewCompleted },
      export: { completed: exportCompleted, artifacts: csvArtifacts },
    },
  };
}

describe('ResourceEnrichmentWorkflowPanel', () => {
  it('never renders an empty body — shows parsed catalog when running', () => {
    render(
      <ResourceEnrichmentWorkflowPanel
        workflow={makeView({ status: 'ready' })}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Catalog parsed')).not.toBeNull();
    expect(screen.getByText('3 rows ready for enrichment.')).not.toBeNull();
  });

  it('shows an enriching state while generating', () => {
    render(
      <ResourceEnrichmentWorkflowPanel
        workflow={makeView({ status: 'generating' })}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Enriching products')).not.toBeNull();
  });

  it('calls onEnrich from the action bar when running', async () => {
    const onEnrich = mock(() => {});
    render(
      <ResourceEnrichmentWorkflowPanel
        workflow={makeView({ status: 'ready' })}
        onClose={() => {}}
        onEnrich={onEnrich}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /start enrichment/i }));
    expect(onEnrich).toHaveBeenCalledTimes(1);
  });

  it('pages through one selection artifact at a time during review', () => {
    render(
      <ResourceEnrichmentWorkflowPanel
        workflow={makeView({ status: 'reviewing', selectionCount: 2 })}
        onClose={() => {}}
        renderSelection={(artifact) => <p>Selection for {artifact.title}</p>}
      />
    );
    expect(screen.getByText('Row 1 of 2')).not.toBeNull();
    expect(screen.getByText('Selection for product-0')).not.toBeNull();
    expect(screen.queryByText('Selection for product-1')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /next row/i }));

    expect(screen.getByText('Row 2 of 2')).not.toBeNull();
    expect(screen.queryByText('Selection for product-0')).toBeNull();
    expect(screen.getByText('Selection for product-1')).not.toBeNull();
  });

  it('hides export until canExport is set', () => {
    render(
      <ResourceEnrichmentWorkflowPanel
        workflow={makeView({ status: 'reviewing', selectionCount: 1, reviewCompleted: false })}
        onClose={() => {}}
        onExport={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: /export csv/i })).toBeNull();
  });

  it('calls onExport when export is allowed', async () => {
    const onExport = mock(() => {});
    render(
      <ResourceEnrichmentWorkflowPanel
        workflow={makeView({ status: 'reviewing', selectionCount: 1, reviewCompleted: true })}
        onClose={() => {}}
        onExport={onExport}
        canExport
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('renders csv download when done', () => {
    render(
      <ResourceEnrichmentWorkflowPanel
        workflow={makeView({ status: 'done', exportCompleted: true })}
        onClose={() => {}}
        renderCsvDownload={() => <a href="/download">Download CSV</a>}
      />
    );
    expect(screen.getByRole('link', { name: /download csv/i })).not.toBeNull();
  });
});
