import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { gamma } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('gamma')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-gamma interchange.tools entry', () => {
  test('declares the gamma credential requirement', () => {
    expect(typeof gamma).toBe('function');
    expect(gamma.id).toBe('@workbench/tools-gamma/gamma');
    expect(gamma.requires).toEqual([toolCredentialEnvKey('gamma')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = gamma(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => gamma({} as BaseEnv)).toThrow();
  });
});
