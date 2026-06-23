/// <reference types="bun" />
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ToolNarrative } from './ToolNarrative';
import { type ToolCall } from './types';

afterEach(() => {
  cleanup();
});

describe('ToolNarrative', () => {
  it('renders the tool name and a query summary from arguments', () => {
    const calls: ToolCall[] = [
      {
        id: 'c1',
        name: 'Exa Search',
        arguments: { query: 'minimax m3', numResults: 5 },
        result: 'some results',
        isError: false,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    expect(screen.getByText('Exa Search')).toBeDefined();
    expect(screen.getByText('· minimax m3')).toBeDefined();
  });

  it('suppresses the raw arg chip when a formatSummary is supplied', () => {
    const calls: ToolCall[] = [
      {
        id: 'c1',
        name: '@workbench/tools-exa/exa:exa_search',
        arguments: { query: 'minimax m3', numResults: 5 },
        result: 'some results',
        isError: false,
      },
    ];
    render(
      <ToolNarrative
        toolCalls={calls}
        formatSummary={() => 'Searching the web for minimax m3'}
      />
    );
    expect(screen.getByText('Searching the web for minimax m3')).toBeDefined();
    // The formatter owns the line, so the duplicate "· minimax m3" chip is gone.
    expect(screen.queryByText('· minimax m3')).toBeNull();
  });

  it('reveals the result when an expandable row is clicked', () => {
    const calls: ToolCall[] = [
      {
        id: 'c1',
        name: 'Exa Search',
        arguments: { query: 'minimax m3' },
        result: 'the full result body',
        isError: false,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    expect(screen.queryByText('the full result body')).toBeNull();
    fireEvent.click(screen.getByText('Exa Search'));
    expect(screen.getByText('the full result body')).toBeDefined();
  });

  it('shows the error result for a failed tool call', () => {
    const calls: ToolCall[] = [
      {
        id: 'c1',
        name: 'Exa Search',
        arguments: { query: 'x' },
        result: 'No matching grants for tool:exa_search/invoke',
        isError: true,
      },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    fireEvent.click(screen.getByText('Exa Search'));
    expect(screen.getByText('No matching grants for tool:exa_search/invoke')).toBeDefined();
  });

  it('does not expand a pending call', () => {
    const calls: ToolCall[] = [{ id: 'c1', name: 'Exa Search', arguments: { query: 'x' } }];
    render(<ToolNarrative toolCalls={calls} />);
    fireEvent.click(screen.getByText('Exa Search'));
    // No result to show; the args pre block must not appear.
    expect(screen.queryByText(/"query"/)).toBeNull();
  });

  it('summarizes a non-priority arg as "key: value" when no known key is present', () => {
    const calls: ToolCall[] = [
      { id: 'c1', name: 'fetch_rows', arguments: { limit: 10 }, result: 'ok' },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    expect(screen.getByText('· limit: 10')).toBeDefined();
  });

  it('omits the summary when arguments have no stringifiable scalar values', () => {
    const calls: ToolCall[] = [
      { id: 'c1', name: 'apply_filter', arguments: { rules: [1, 2, 3] }, result: 'ok' },
    ];
    render(<ToolNarrative toolCalls={calls} />);
    expect(screen.queryByText(/·/)).toBeNull();
  });
});
