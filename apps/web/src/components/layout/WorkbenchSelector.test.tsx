/// <reference types="bun" />
import '../../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router';

let workbenchesResult: {
  data?: { id: string; tenantSlug: string; tenantName: string }[];
  isLoading: boolean;
};

mock.module('../../hooks/use-workbenches', () => ({
  useWorkbenches: () => workbenchesResult,
}));

const { WorkbenchSelector } = require('./WorkbenchSelector');

afterEach(() => cleanup());

function renderSelector(path = '/') {
  render(
    React.createElement(
      MemoryRouter,
      { initialEntries: [path] },
      React.createElement(WorkbenchSelector)
    )
  );
}

describe('WorkbenchSelector', () => {
  it('renders nothing when the member has no workbenches', () => {
    workbenchesResult = { data: [], isLoading: false };
    const { container } = render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        React.createElement(WorkbenchSelector)
      )
    );
    expect(container.textContent).toBe('');
  });

  it('opens and lists workbenches', () => {
    workbenchesResult = {
      data: [
        { id: 'p1', tenantSlug: 'acme', tenantName: 'Acme Corp' },
        { id: 'p2', tenantSlug: 'globex', tenantName: 'Globex' },
      ],
      isLoading: false,
    };
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: /workbenches/i }));
    expect(screen.getByRole('option', { name: 'Acme Corp' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Globex' })).toBeDefined();
  });

  it('shows the active workbench name from the route', () => {
    workbenchesResult = {
      data: [{ id: 'p1', tenantSlug: 'acme', tenantName: 'Acme Corp' }],
      isLoading: false,
    };
    renderSelector('/workbenches/acme');
    expect(screen.getByText('Acme Corp')).toBeDefined();
  });
});
