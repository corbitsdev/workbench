/// <reference types="bun" />
import '../test-setup';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): React.ReactElement {
  throw new Error('render exploded');
}

afterEach(cleanup);

describe('ErrorBoundary', () => {
  it('renders the default fallback when a child throws during render', () => {
    render(React.createElement(ErrorBoundary, null, React.createElement(Boom, null)));
    screen.getByText(/something went wrong/i);
    expect(screen.queryByText('render exploded')).toBeNull();
  });

  it('renders a custom fallback when provided', () => {
    render(
      React.createElement(ErrorBoundary, {
        fallback: React.createElement('p', null, 'custom fallback'),
        children: React.createElement(Boom, null),
      })
    );
    screen.getByText('custom fallback');
  });

  it('renders children unchanged when nothing throws', () => {
    render(
      React.createElement(ErrorBoundary, null, React.createElement('p', null, 'healthy child'))
    );
    screen.getByText('healthy child');
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
});
