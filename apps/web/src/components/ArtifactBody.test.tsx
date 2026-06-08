/// <reference types="bun" />
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import ArtifactBody from './ArtifactBody';

afterEach(() => {
  cleanup();
});

const TEST_BODY = '# Hello\n\nThis is test content.';
const containsHello = (content: string) => content.includes('Hello');

describe('ArtifactBody rendering', () => {
  it('renders email body for email', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'email' }));
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders linkedin body for linkedin-post', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'linkedin-post' }));
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders linkedin body for twitter-post', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'twitter-post' }));
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders linkedin body for founder-pov-post', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'founder-pov-post' }));
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders one-pager body for one-pager', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'one-pager' }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders one-pager body for blog', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'blog' }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders one-pager body for case-study', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'case-study' }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders one-pager body for objection-handling', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'objection-handling' }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders one-pager body for customer-quotes', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'customer-quotes' }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders battlecard body for battlecard', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'battlecard' }));
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders markdown body for pain-points', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'pain-points' }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders markdown body for call-transcript', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'call-transcript' }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders markdown body for unknown kind instead of blank screen', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'unknown-kind' as any }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  // Backward-compatibility: old artifact kind names still render
  it('renders email body for follow-up-email (legacy)', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'follow-up-email' as any }));
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders linkedin body for pain-points-linkedin-post (legacy)', () => {
    render(
      React.createElement(ArtifactBody, {
        body: TEST_BODY,
        type: 'pain-points-linkedin-post' as any,
      })
    );
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders linkedin body for pain-points-twitter-post (legacy)', () => {
    render(
      React.createElement(ArtifactBody, {
        body: TEST_BODY,
        type: 'pain-points-twitter-post' as any,
      })
    );
    expect(screen.getByText(containsHello)).toBeDefined();
  });

  it('renders one-pager body for sales-one-pager (legacy)', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'sales-one-pager' as any }));
    expect(screen.getByText('Hello')).toBeDefined();
  });

  it('renders one-pager body for case-study-draft (legacy)', () => {
    render(React.createElement(ArtifactBody, { body: TEST_BODY, type: 'case-study-draft' as any }));
    expect(screen.getByText('Hello')).toBeDefined();
  });
});
