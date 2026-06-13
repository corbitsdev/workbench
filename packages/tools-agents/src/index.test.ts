import { describe, expect, it } from 'bun:test';
import { parseListLimit, parsePrincipalIds, resolveStatusFilter } from './index';

describe('resolveStatusFilter', () => {
  it('defaults to running when no status is given', () => {
    expect(resolveStatusFilter(undefined)).toBe('running');
  });

  it('returns the granular status when a valid one is given', () => {
    expect(resolveStatusFilter('stopped')).toBe('stopped');
    expect(resolveStatusFilter('error')).toBe('error');
  });

  it('returns undefined (no filter) for the all escape hatch', () => {
    expect(resolveStatusFilter('all')).toBeUndefined();
  });

  it('throws including all in the allowed list for an unknown status', () => {
    expect(() => resolveStatusFilter('banana')).toThrow(/status must be one of:.*all/);
  });

  it('throws when status is not a string', () => {
    expect(() => resolveStatusFilter(5)).toThrow(/status must be a string/);
  });
});

describe('parsePrincipalIds', () => {
  it('returns undefined when no principals are given', () => {
    expect(parsePrincipalIds(undefined)).toBeUndefined();
  });

  it('returns the provided principal ids when given a non-empty array', () => {
    expect(parsePrincipalIds(['prn_a', 'prn_b'])).toEqual(['prn_a', 'prn_b']);
  });

  it('throws when principals is not an array', () => {
    expect(() => parsePrincipalIds('prn_a')).toThrow(/principals must be an array/);
  });

  it('throws when principals is an empty array', () => {
    expect(() => parsePrincipalIds([])).toThrow(/non-empty/);
  });

  it('throws when principals contains a non-string element', () => {
    expect(() => parsePrincipalIds(['prn_a', 5])).toThrow(/principals must contain only strings/);
  });
});

describe('parseListLimit', () => {
  it('defaults to 50 when not a finite number', () => {
    expect(parseListLimit(undefined)).toBe(50);
    expect(parseListLimit('x')).toBe(50);
  });

  it('clamps to the 1-200 range', () => {
    expect(parseListLimit(9999)).toBe(200);
    expect(parseListLimit(0)).toBe(1);
    expect(parseListLimit(10)).toBe(10);
  });
});
