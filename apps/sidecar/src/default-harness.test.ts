import { describe, it, expect, mock } from 'bun:test';

// Mock heavy dependencies before importing the module under test.
// build() touches isogit, posix tools, and LSP — all real filesystem/process
// operations. We mock at the module boundary to keep the tests fast and hermetic.

mock.module('@intx/storage-isogit', () => ({
  createIsogitStore: mock(async () => ({
    type: 'isogit',
  })),
  createMailAuditStore: mock(async () => ({
    type: 'mail-audit',
  })),
}));

mock.module('@intx/harness', () => ({
  createHarness: mock(() => ({ type: 'harness' })),
  readDeployTree: mock(async () => ({ systemPrompt: null })),
}));

mock.module('@intx/tools-posix', () => ({
  createPosixTools: mock(() => ({
    dispose: mock(async () => {}),
  })),
}));

mock.module('@intx/tools-lsp', () => ({
  createLSPPlugin: mock(() => ({})),
}));

mock.module('@intx/authz', () => ({
  evaluateGrants: mock(async () => {}),
}));

mock.module('@intx/types/runtime', () => ({
  createBlobReader: mock(() => ({})),
}));

import { createDefaultHarnessBuilder } from './default-harness';
import type { InferenceSource } from '@intx/types/runtime';

const validSource: InferenceSource = {
  id: 'src-1',
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
};

describe('createDefaultHarnessBuilder', () => {
  describe('canBuildSource', () => {
    it('does not throw for a registered provider', () => {
      const builder = createDefaultHarnessBuilder();
      expect(() => builder.canBuildSource(validSource)).not.toThrow();
    });

    it('throws for an unknown provider', () => {
      const builder = createDefaultHarnessBuilder();
      const unknownSource: InferenceSource = { ...validSource, provider: 'unknown-provider-xyz' };
      expect(() => builder.canBuildSource(unknownSource)).toThrow(
        'Source provider "unknown-provider-xyz" is not registered'
      );
    });
  });

  describe('build()', () => {
    it('returns a bundle with harness, mailStore, and disposers', async () => {
      const builder = createDefaultHarnessBuilder();

      const bundle = await builder.build({
        agentAddress: 'agent@tenant.localhost',
        agentConfig: {
          agentAddress: 'agent@tenant.localhost',
          agentId: 'agent-1',
          sessionId: 'session-1',
          sources: [validSource],
          defaultSource: 'src-1',
          grants: [],
          tools: [],
          principalId: 'user-1',
          tenantId: 'tenant-1',
          systemPrompt: 'You are a helpful assistant.',
        },
        source: validSource,
        storeDir: '/tmp/test-store',
        agentTransport: {} as any,
        crypto: {
          signSSH: mock(() => 'sig'),
        } as any,
        onEvent: mock(() => {}),
        onConnectorStateChanged: mock(() => {}),
      });

      expect(bundle.harness).toBeDefined();
      expect(bundle.mailStore).toBeDefined();
      expect(Array.isArray(bundle.disposers)).toBe(true);
      expect(bundle.disposers.length).toBeGreaterThan(0);
    });
  });
});
