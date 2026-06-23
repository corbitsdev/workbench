import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { granola } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('granola')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-granola interchange.tools entry', () => {
  test('declares the granola credential requirement', () => {
    expect(typeof granola).toBe('function');
    expect(granola.id).toBe('@workbench/tools-granola/granola');
    expect(granola.requires).toEqual([toolCredentialEnvKey('granola')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = granola(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => granola({} as BaseEnv)).toThrow();
  });
});
