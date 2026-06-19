import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { reddit } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('scrapecreators')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-reddit interchange.tools entry', () => {
  test('declares the scrapecreators credential requirement', () => {
    expect(typeof reddit).toBe('function');
    expect(reddit.id).toBe('@workbench/tools-reddit/reddit');
    expect(reddit.requires).toEqual([toolCredentialEnvKey('scrapecreators')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = reddit(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => reddit({} as BaseEnv)).toThrow();
  });
});
