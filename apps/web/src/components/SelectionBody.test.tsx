/// <reference types="bun" />
import '../test-setup';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { buildSelectionArtifactContent } from '@workbench/gtm-workflows';
import SelectionBody from './SelectionBody';

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

const originalFetch = globalThis.fetch;
let patches: Array<{ url: string; body: unknown }> = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  window.happyDOM.setURL('http://localhost/');
  patches = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PATCH') {
      patches.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const FIELDS = {
  Title: ['t1', 't2', 't3', 't4', 't5'],
  Description: ['d1', 'd2', 'd3', 'd4', 'd5'],
};

function renderBody(content: string, props: { workflowId?: string; artifactId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SelectionBody, {
        content,
        workflowId: props.workflowId ?? 'wf-1',
        artifactId: props.artifactId ?? 'a-1',
      })
    )
  );
}

describe('SelectionBody', () => {
  it('shows one field at a time with stepper controls', async () => {
    const view = renderBody(
      buildSelectionArtifactContent({ label: 'Row 1', fields: FIELDS, chosen: null })
    );
    expect(view.getAllByRole('radio')).toHaveLength(5);
    expect(view.getAllByText('Title')).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(view.getByRole('button', { name: 'Next section' }));
    expect(view.getAllByText('Description')).toHaveLength(2);
    expect(view.getAllByRole('radio')).toHaveLength(5);
  });

  it('keeps the chosen value selected for the active field', async () => {
    const view = renderBody(
      buildSelectionArtifactContent({ label: 'Row 1', fields: FIELDS, chosen: { Title: 2 } })
    );
    expect((view.getByDisplayValue('Title:2') as HTMLInputElement).checked).toBe(true);
    const user = userEvent.setup();
    await user.click(view.getByRole('button', { name: 'Next section' }));
    expect((view.getByDisplayValue('Description:0') as HTMLInputElement).checked).toBe(false);
  });

  it('supports arbitrary field names for a row', async () => {
    const view = renderBody(
      buildSelectionArtifactContent({
        label: 'Row 1',
        fields: { 'Meta Title': ['mt1'], 'Alt Text': ['alt1'] },
        chosen: null,
      })
    );
    expect(view.getAllByText('Meta Title')).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(view.getByRole('button', { name: 'Alt Text' }));
    expect(view.getByDisplayValue('Alt Text:0')).not.toBeNull();
  });

  it('PATCHes the chosen indices on submit', async () => {
    const view = renderBody(
      buildSelectionArtifactContent({ label: 'Row 1', fields: FIELDS, chosen: null })
    );
    const user = userEvent.setup();
    await user.click(view.getByDisplayValue('Title:1'));
    await user.click(view.getByRole('button', { name: 'Description' }));
    await user.click(view.getByDisplayValue('Description:0'));
    await user.click(view.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].url).toContain('/workflows/wf-1/artifacts/a-1/selection');
    expect(patches[0].body).toEqual({ chosen: { Title: 1, Description: 0 } });
  });
});
