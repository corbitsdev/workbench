import { describe, expect, it } from 'bun:test';
import { friendlyToolSummary, summarizeToolCalls, toolOperationKey } from './friendly-tool-summary';
import type { ToolCall } from '@workbench/chat';

function call(name: string, args?: Record<string, unknown>): ToolCall {
  return {
    id: 'tc_1',
    name,
    ...(args !== undefined ? { arguments: args } : {}),
  };
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

describe('summarizeToolCalls', () => {
  const q = (name: string): ToolCall => call(name);

  it('returns an empty string for no calls', () => {
    expect(summarizeToolCalls([])).toBe('');
  });

  it('rolls up multiple families, ordered by first appearance, with counts', () => {
    const calls = [
      q('@workbench/tools-attio/attio:attio_search_records'),
      q('@workbench/tools-attio/attio:attio_get_record'),
      q('@workbench/tools-attio/attio:attio_get_record'),
      q('@workbench/tools-attio/attio:attio_get_record'),
      q('@workbench/tools-attio/attio:attio_get_record'),
      q('@workbench/tools-attio/attio:attio_query_records'),
      q('@workbench/tools-granola/granola:granola_list_notes'),
      q('@workbench/tools-granola/granola:granola_get_note'),
      q('@workbench/tools-granola/granola:granola_get_note'),
      q('@workbench/tools-granola/granola:granola_get_note'),
      q('@workbench/tools-granola/granola:granola_get_note'),
      q('@workbench/tools-linear/linear:linear_list_issues'),
      q('@workbench/tools-linear/linear:linear_get_issue'),
    ];
    expect(summarizeToolCalls(calls)).toBe(
      'Searched Attio 6×, read 5 notes, and checked Linear 2×'
    );
  });

  it('joins exactly two families with "and" and no comma', () => {
    const calls = [
      q('@workbench/tools-attio/attio:attio_get_record'),
      q('@workbench/tools-attio/attio:attio_get_record'),
      q('@workbench/tools-linear/linear:linear_get_issue'),
    ];
    expect(summarizeToolCalls(calls)).toBe('Searched Attio 2× and checked Linear');
  });

  it('omits the count suffix for a single call in a repeated-verb family', () => {
    expect(summarizeToolCalls([q('@workbench/tools-attio/attio:attio_get_record')])).toBe(
      'Searched Attio'
    );
  });

  it('uses a singular noun for one counted-noun call', () => {
    expect(summarizeToolCalls([q('@workbench/tools-granola/granola:granola_get_note')])).toBe(
      'Read 1 note'
    );
  });

  it('pluralizes a counted-noun family', () => {
    const calls = [
      q('@workbench/tools-granola/granola:granola_get_note'),
      q('@workbench/tools-granola/granola:granola_list_notes'),
    ];
    expect(summarizeToolCalls(calls)).toBe('Read 2 notes');
  });

  it('falls back to a humanized family name for an unknown family', () => {
    const calls = [
      q('@acme/tools-widget/widget:widget_poke'),
      q('@acme/tools-widget/widget:widget_poke'),
    ];
    expect(summarizeToolCalls(calls)).toBe('Widget 2×');
  });
});

describe('summarizeToolCalls styles', () => {
  const attio = (n: number): ToolCall[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      name: '@workbench/tools-attio/attio:attio_get_record',
      result: 'ok',
    }));
  const notes = (n: number): ToolCall[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `g${i}`,
      name: '@workbench/tools-granola/granola:granola_get_note',
      result: 'ok',
    }));
  const linear = (result: string): ToolCall => ({
    id: 'l1',
    name: '@workbench/tools-linear/linear:linear_list_issues',
    result,
  });

  it('natural style spells two as "twice"', () => {
    expect(summarizeToolCalls(attio(2), 'natural')).toBe('Searched Attio twice');
  });

  it('natural style spells larger counts as "N times"', () => {
    expect(summarizeToolCalls(attio(6), 'natural')).toBe('Searched Attio 6 times');
  });

  it('varied style swaps in the alternate verb', () => {
    expect(summarizeToolCalls([...attio(6), ...notes(5)], 'varied')).toBe(
      'Combed Attio 6 times and skimmed 5 notes'
    );
  });

  it('detail style surfaces a high-priority Linear issue from the result', () => {
    const calls = [
      linear(
        JSON.stringify([
          { id: 'a', priority: 'High' },
          { id: 'b', priority: 'Low' },
        ])
      ),
    ];
    expect(summarizeToolCalls(calls, 'detail')).toBe('Found 2 Linear issues (one high-priority)');
  });

  it('detail style falls back to the plain clause when the result is not parseable', () => {
    expect(summarizeToolCalls([linear('not json'), linear('also not json')], 'detail')).toBe(
      'Checked Linear twice'
    );
  });

  it('mixed style combines varied verbs, natural counts, and detail', () => {
    const calls = [
      ...attio(6),
      ...notes(5),
      linear(
        JSON.stringify([
          { id: 'a', priority: 'Urgent' },
          { id: 'b', priority: 'Medium' },
        ])
      ),
    ];
    expect(summarizeToolCalls(calls, 'mixed')).toBe(
      'Combed Attio 6 times, skimmed 5 notes, and found 2 Linear issues (one high-priority)'
    );
  });

  it('symbols remains the default', () => {
    expect(summarizeToolCalls(attio(6))).toBe('Searched Attio 6×');
    expect(summarizeToolCalls(attio(6), 'symbols')).toBe('Searched Attio 6×');
  });
});
