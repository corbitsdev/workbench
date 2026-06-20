import { describe, it, expect } from 'bun:test';
import { buildLocalCommand, LOCAL_ACTIONS, type LocalAction } from './local';

describe('buildLocalCommand', () => {
  it('threads the selected tenant into a tenant-aware action', () => {
    const action: LocalAction = { label: 'x', script: 'seed-credentials.ts', tenantAware: true };
    expect(buildLocalCommand(action, '/bin', 'gtm', [])).toEqual([
      'run',
      '/bin/seed-credentials.ts',
      '--tenant',
      'gtm',
    ]);
  });

  it('omits the tenant flag for non-tenant-aware actions', () => {
    const action: LocalAction = { label: 'x', script: 'build-tool-packages.ts' };
    expect(buildLocalCommand(action, '/bin', 'gtm', [])).toEqual([
      'run',
      '/bin/build-tool-packages.ts',
    ]);
  });

  it('places baseArgs and extra args before the tenant flag', () => {
    const action: LocalAction = {
      label: 'x',
      script: 'publish-tool-packages.ts',
      baseArgs: ['--from', 'dist/tool-packages'],
      tenantAware: true,
    };
    expect(buildLocalCommand(action, '/bin', 'sales', ['--kind', 'foo'])).toEqual([
      'run',
      '/bin/publish-tool-packages.ts',
      '--from',
      'dist/tool-packages',
      '--kind',
      'foo',
      '--tenant',
      'sales',
    ]);
  });

  it('only the bootstrap superadmin seed is marked bootstrap', () => {
    const bootstrap = LOCAL_ACTIONS.filter((a) => a.bootstrap).map((a) => a.script);
    expect(bootstrap).toEqual(['seed.ts']);
  });
});
