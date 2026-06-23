import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { x } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('xai')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-x interchange.tools entry', () => {
  test('declares the xai credential requirement', () => {
    expect(typeof x).toBe('function');
    expect(x.id).toBe('@workbench/tools-x/x');
    expect(x.requires).toEqual([toolCredentialEnvKey('xai')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = x(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => x({} as BaseEnv)).toThrow();
  });
});
