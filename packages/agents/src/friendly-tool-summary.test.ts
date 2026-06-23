import { describe, expect, it } from 'bun:test';
import { friendlyToolSummary, toolOperationKey } from './friendly-tool-summary';
import type { ToolCall } from '@workbench/chat';

function call(name: string, args?: Record<string, unknown>): ToolCall {
  return { id: 'tc_1', name, ...(args !== undefined ? { arguments: args } : {}) };
}

describe('toolOperationKey', () => {
  it('takes the substring after the last colon in a fully-qualified name', () => {
    expect(toolOperationKey('@workbench/tools-granola/granola:granola_get_note')).toBe(
      'granola_get_note'
    );
  });

  it('returns the whole name when there is no colon', () => {
    expect(toolOperationKey('granola_get_note')).toBe('granola_get_note');
  });
});

describe('friendlyToolSummary', () => {
  it('maps a known operation to its friendly verb phrase', () => {
    expect(friendlyToolSummary(call('@workbench/tools-granola/granola:granola_get_note'))).toBe(
      'Loading a transcript'
    );
    expect(friendlyToolSummary(call('@workbench/tools-linear/linear:linear_list_issues'))).toBe(
      'Looking through Linear issues'
    );
    expect(friendlyToolSummary(call('@workbench/tools-granola/granola:granola_list_notes'))).toBe(
      'Finding recent meetings'
    );
  });

  it('interpolates a query argument when present', () => {
    expect(
      friendlyToolSummary(call('@workbench/tools-exa/exa:exa_search', { query: 'minimax m3' }))
    ).toBe('Searching the web for minimax m3');
  });

  it('interpolates a url argument for firecrawl_scrape', () => {
    expect(
      friendlyToolSummary(
        call('@workbench/tools-firecrawl/firecrawl:firecrawl_scrape', {
          url: 'https://example.com',
        })
      )
    ).toBe('Reading https://example.com');
  });

  it('falls back to the static phrase when an interpolating op has no useful arg', () => {
    expect(friendlyToolSummary(call('@workbench/tools-exa/exa:exa_search'))).toBe(
      'Searching the web'
    );
    expect(friendlyToolSummary(call('@workbench/tools-exa/exa:exa_search', { query: '   ' }))).toBe(
      'Searching the web'
    );
  });

  it('falls back to toHumanLabel for an unknown operation', () => {
    expect(friendlyToolSummary(call('@workbench/tools-mystery/mystery:mystery_do_thing'))).toBe(
      'Mystery Do Thing'
    );
  });

  it('falls back to toHumanLabel using the operation key, not the full name', () => {
    // Regression guard: the old behavior turned the whole FQN into garbage.
    const result = friendlyToolSummary(call('@workbench/tools-x/unknown:some_new_op'));
    expect(result).toBe('Some New Op');
    expect(result).not.toContain('@workbench');
    expect(result).not.toContain('/');
  });
});
