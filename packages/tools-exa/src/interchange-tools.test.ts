import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { exa } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('exa')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-exa interchange.tools entry', () => {
  test('declares the exa credential requirement', () => {
    expect(typeof exa).toBe('function');
    expect(exa.id).toBe('@workbench/tools-exa/exa');
    expect(exa.requires).toEqual([toolCredentialEnvKey('exa')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = exa(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => exa({} as BaseEnv)).toThrow();
  });
});
