import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { buildEntries } from './seed-credentials';

describe('seed-credentials buildEntries', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('includes github entry when GITHUB_API_KEY is set', () => {
    process.env['GITHUB_API_KEY'] = 'ghp_test123';

    const entries = buildEntries();

    const github = entries.find((e) => e.providerName === 'github');
    expect(github).toBeDefined();
    expect(github?.secret).toBe('ghp_test123');
    expect(github?.providerPlugin).toBe('github');
  });

  it('omits github entry when GITHUB_API_KEY is not set', () => {
    delete process.env['GITHUB_API_KEY'];

    const entries = buildEntries();

    expect(entries.find((e) => e.providerName === 'github')).toBeUndefined();
  });
});
