/// <reference types="bun" />
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { useMediaQuery } from './use-media-query';

// Deterministic matchMedia stub: a query matches when it appears in `matching`.
function stubMatchMedia(matching: string[]) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matching.includes(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // Legacy API some libs still call.
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

let restore: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

function Probe({ query }: { query: string }) {
  const matches = useMediaQuery(query);
  return React.createElement('span', null, matches ? 'match' : 'no-match');
}

describe('useMediaQuery', () => {
  it('returns true when the query matches', () => {
    restore = stubMatchMedia(['(min-width: 1024px)']);
    render(React.createElement(Probe, { query: '(min-width: 1024px)' }));
    expect(screen.getByText('match')).toBeDefined();
  });

  it('returns false when the query does not match', () => {
    restore = stubMatchMedia([]);
    render(React.createElement(Probe, { query: '(min-width: 1024px)' }));
    expect(screen.getByText('no-match')).toBeDefined();
  });
});
