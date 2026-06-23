import { describe, expect, test } from 'bun:test';
import type { BaseEnv } from '@intx/agent';
import { toolCredentialEnvKey } from '@workbench/tool-credentials';
import { attio } from './interchange-tools';

const env = {
  [toolCredentialEnvKey('attio')]: { apiKey: 'test-key', baseURL: 'https://api.test' },
} as unknown as BaseEnv;

describe('@workbench/tools-attio interchange.tools entry', () => {
  test('declares the attio credential requirement', () => {
    expect(typeof attio).toBe('function');
    expect(attio.id).toBe('@workbench/tools-attio/attio');
    expect(attio.requires).toEqual([toolCredentialEnvKey('attio')]);
  });

  test('builds its tools against the injected credential', () => {
    const bundle = attio(env);
    expect(bundle.definitions.length).toBe(4);
    expect(bundle.definitions.map((d) => d.name).sort()).toEqual([
      'attio_get_record',
      'attio_list_objects',
      'attio_list_workspace_members',
      'attio_query_records',
    ]);
  });

  test('throws at construction when the credential is absent', () => {
    expect(() => attio({} as BaseEnv)).toThrow();
  });
});
