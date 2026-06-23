import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { firecrawl } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('firecrawl')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-firecrawl interchange.tools entry', () => {
  test('declares the firecrawl credential requirement', () => {
    expect(typeof firecrawl).toBe('function');
    expect(firecrawl.id).toBe('@workbench/tools-firecrawl/firecrawl');
    expect(firecrawl.requires).toEqual([toolCredentialEnvKey('firecrawl')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = firecrawl(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => firecrawl({} as BaseEnv)).toThrow();
  });
});
