import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { youtube } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('youtube')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-youtube interchange.tools entry', () => {
  test('declares the youtube credential requirement', () => {
    expect(typeof youtube).toBe('function');
    expect(youtube.id).toBe('@workbench/tools-youtube/youtube');
    expect(youtube.requires).toEqual([toolCredentialEnvKey('youtube')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = youtube(env);
    expect(bundle.definitions.length).toBeGreaterThan(0);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => youtube({} as BaseEnv)).toThrow();
  });
});
