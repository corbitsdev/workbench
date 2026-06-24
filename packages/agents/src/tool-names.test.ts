/// <reference types="bun" />
import { describe, expect, it } from 'bun:test';
import {
  canonicalizeToolNames,
  expandToolAliasGrants,
  providersForToolPackages,
} from './tool-names';

describe('canonicalizeToolNames (CL-2145)', () => {
  it('prefixes a package tool with its factory id', () => {
    expect(canonicalizeToolNames(['granola_list_notes'])).toEqual([
      '@workbench/tools-granola/granola:granola_list_notes',
    ]);
  });

  it('maps web_search to the exa package, not a local runner', () => {
    expect(canonicalizeToolNames(['web_search'])).toEqual(['@workbench/tools-exa/exa:web_search']);
  });

  it('uses the last30days /core factory id for its tools', () => {
    expect(canonicalizeToolNames(['last30days_validate'])).toEqual([
      '@workbench/tools-last30days/core:last30days_validate',
    ]);
  });

  it('leaves local runner tools (mail/posix) unprefixed', () => {
    expect(canonicalizeToolNames(['mail_search', 'read_file', 'run_shell'])).toEqual([
      'mail_search',
      'read_file',
      'run_shell',
    ]);
  });

  it('passes through names with no known package (no false prefixing)', () => {
    expect(canonicalizeToolNames(['granola_search'])).toEqual(['granola_search']);
  });

  it('produces names that match the sidecar authz resource at invoke time', () => {
    // The loader emits `<factoryId>:<name>` and authz checks `tool:<runtime name>`
    // (interchange inference/authz-extension). The grant seeded from a canonical
    // capability name must therefore equal that resource string.
    const [canonical] = canonicalizeToolNames(['granola_list_notes']);
    const seededResource = `tool:${canonical}`;
    const runtimeResource = 'tool:@workbench/tools-granola/granola:granola_list_notes';
    expect(seededResource).toBe(runtimeResource);
  });
});

describe('expandToolAliasGrants', () => {
  it('adds web_search when capabilities only list exa_search', () => {
    const expanded = expandToolAliasGrants(canonicalizeToolNames(['exa_search']));
    expect(expanded).toContain('@workbench/tools-exa/exa:exa_search');
    expect(expanded).toContain('@workbench/tools-exa/exa:web_search');
  });

  it('does not expand unrelated tools', () => {
    const expanded = expandToolAliasGrants(
      canonicalizeToolNames(['read_file', 'granola_list_notes'])
    );
    expect(expanded).toEqual(['read_file', '@workbench/tools-granola/granola:granola_list_notes']);
  });
});

describe('providersForToolPackages', () => {
  it('maps a credentialed package pin to its provider', () => {
    expect(
      providersForToolPackages([{ name: '@workbench/tools-granola', version: '^0.1.0' }])
    ).toEqual(['granola']);
  });

  it('dedupes packages that share a provider (reddit + scrapecreators)', () => {
    expect(
      providersForToolPackages([
        { name: '@workbench/tools-reddit', version: '^0.1.0' },
        { name: '@workbench/tools-scrapecreators', version: '^0.1.0' },
      ])
    ).toEqual(['scrapecreators']);
  });

  it('ignores keyless / hub-backed packages', () => {
    expect(
      providersForToolPackages([
        { name: '@workbench/tools-artifact', version: '^0.1.0' },
        { name: '@workbench/tools-hackernews', version: '^0.1.0' },
      ])
    ).toEqual([]);
  });
});
