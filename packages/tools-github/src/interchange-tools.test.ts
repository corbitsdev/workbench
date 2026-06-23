import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { github } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('github')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-github interchange.tools entry', () => {
  test('declares the github credential requirement', () => {
    expect(typeof github).toBe('function');
    expect(github.id).toBe('@workbench/tools-github/github');
    expect(github.requires).toEqual([toolCredentialEnvKey('github')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = github(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => github({} as BaseEnv)).toThrow();
  });
});
