import { describe, expect, it } from 'bun:test';
import { cn } from './utils';

describe('cn', () => {
  it('joins truthy class names and drops falsy ones', () => {
    const omit = '' as string | false;
    expect(cn('a', omit && 'b', undefined, null, 'c')).toBe('a c');
  });

  it('merges conflicting tailwind utilities, keeping the last', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('flattens arrays and conditional objects', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });
});
