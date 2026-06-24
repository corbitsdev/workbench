/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

let ctx: {
  workbenches: unknown[];
  loading: boolean;
  activeWorkbench: { id: string; tenantSlug: string; tenantName: string; tenantId: string } | null;
  activeTenantId: string | null;
  setActiveWorkbench: (id: string) => void;
};

mock.module('../lib/active-workbench-context', () => ({
  useActiveWorkbench: () => ctx,
}));

const { ArtifactsPage } = require('./ArtifactsPage');

afterEach(() => cleanup());

describe('ArtifactsPage', () => {
  it('shows a loading state while workbenches load', () => {
    ctx = {
      workbenches: [],
      loading: true,
      activeWorkbench: null,
      activeTenantId: null,
      setActiveWorkbench: () => {},
    };
    render(React.createElement(ArtifactsPage));
    expect(screen.getByText('Loading…')).toBeDefined();
  });

  it('shows a no-access message when the member has no workbenches', () => {
    ctx = {
      workbenches: [],
      loading: false,
      activeWorkbench: null,
      activeTenantId: null,
      setActiveWorkbench: () => {},
    };
    render(React.createElement(ArtifactsPage));
    expect(screen.getByText(/not been provided access/i)).toBeDefined();
  });
});
