/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { ReviewedArtifactsSummary } from './ReviewedArtifactsSummary';

afterEach(cleanup);

describe('ReviewedArtifactsSummary', () => {
  it('lists approved artifact titles and the saved note', () => {
    const view = render(
      React.createElement(ReviewedArtifactsSummary, {
        approvedArtifacts: [
          { id: 'a-1', title: 'Email draft' },
          { id: 'a-2', title: 'Battlecard' },
        ],
      })
    );
    view.getByText('Email draft');
    view.getByText('Battlecard');
    view.getByText(/your approved pieces have been saved/i);
  });

  it('shows the all-denied message when nothing was approved', () => {
    const view = render(
      React.createElement(ReviewedArtifactsSummary, {
        approvedArtifacts: [],
      })
    );
    view.getByText(/all pieces were denied/i);
    expect(view.queryByText(/your approved pieces have been saved/i)).toBeNull();
  });
});
