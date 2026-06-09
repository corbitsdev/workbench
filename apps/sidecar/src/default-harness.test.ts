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

// The new runtime exposes events only through `harness.stream()`. The
// builder subscribes to it and forwards events, so the mocked harness
// must return an async-iterable stream that closes immediately.
const createHarnessMock = mock(async () => ({
  type: 'harness',
  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream() {
    // Empty stream: closes immediately so the builder's forwarding
    // drain settles without emitting any event.
  },
  async close() {},
}));

mock.module('@intx/harness', () => ({
  createHarness: createHarnessMock,
}));

mock.module('@intx/hub-agent', () => ({
  readDeployTree: mock(async () => ({ systemPrompt: undefined })),
}));

mock.module('@intx/tools-posix', () => ({
  createPosixTools: mock(() => ({
    definitions: [{ name: 'read_file' }, { name: 'write_file' }],
    dispose: mock(async () => {}),
    run: mock(async () => ({ callId: 'x', content: '' })),
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

import { combineRunners, createDefaultHarnessBuilder, wsUrlToHttp } from './default-harness';
import type { InferenceSource, ToolDefinition, ToolRunner } from '@intx/types/runtime';
const TEST_TENANT_ID = 'tenant-1';

const validSource: InferenceSource = {
  id: 'src-1',
  provider: 'openai',
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
};

describe('wsUrlToHttp', () => {
  it('returns origin only, stripping the websocket path', () => {
    expect(wsUrlToHttp('ws://staging-hub.railway.internal:8080/api/sidecars/ws')).toBe(
      'http://staging-hub.railway.internal:8080'
    );
  });

  it('converts wss to https and strips the path', () => {
    expect(wsUrlToHttp('wss://hub.example.com/api/sidecars/ws')).toBe('https://hub.example.com');
  });

  it('handles a url with no path', () => {
    expect(wsUrlToHttp('ws://localhost:4000')).toBe('http://localhost:4000');
  });
});

describe('createDefaultHarnessBuilder', () => {
  describe('canBuildSource', () => {
    it('does not throw for a registered provider', () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: 'http://localhost:4000',
        sidecarToken: 'test-token',

      });
      expect(() => builder.canBuildSource(validSource)).not.toThrow();
    });

    it('throws for an unknown provider', () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: 'http://localhost:4000',
        sidecarToken: 'test-token',

      });
      const unknownSource: InferenceSource = { ...validSource, provider: 'unknown-provider-xyz' };
      expect(() => builder.canBuildSource(unknownSource)).toThrow(
        'Source provider "unknown-provider-xyz" is not registered'
      );
    });
  });

  describe('build()', () => {
    it('returns a bundle with harness, mailStore, and disposers', async () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: 'http://localhost:4000',
        sidecarToken: 'test-token',

      });

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

  describe('combineRunners', () => {
    const makeRunner = (names: string[]): ToolRunner & { definitions: ToolDefinition[] } => ({
      definitions: names.map((name) => ({ name }) as unknown as ToolDefinition),
      async run(call) {
        return { callId: call.id, content: `ran:${call.name}` };
      },
    });

    it('merges definitions from every runner', () => {
      const merged = combineRunners([makeRunner(['read_file']), makeRunner(['artifact_link'])]);
      const names = merged.definitions.map((d) => d.name);
      expect(names).toContain('read_file');
      expect(names).toContain('artifact_link');
    });

    it('dispatches a call to the runner that owns the named tool', async () => {
      const merged = combineRunners([makeRunner(['a']), makeRunner(['b'])]);
      const result = await merged.run(
        { id: 'c1', name: 'b', arguments: {} } as any,
        new AbortController().signal
      );
      expect(result.content).toBe('ran:b');
    });

    it('returns an error result for an unregistered tool name', async () => {
      const merged = combineRunners([makeRunner(['a'])]);
      const result = await merged.run(
        { id: 'c1', name: 'missing', arguments: {} } as any,
        new AbortController().signal
      );
      expect(result.isError).toBe(true);
    });
  });

  describe('hub tool runner composition', () => {
    it('excludes POSIX tools from the hub tool runner', async () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: 'http://localhost:4000',
        sidecarToken: 'test-token',

      });

      const bundle = await builder.build({
        agentAddress: 'agent@tenant.localhost',
        agentConfig: {
          agentAddress: 'agent@tenant.localhost',
          agentId: 'agent-1',
          sessionId: 'session-1',
          sources: [validSource],
          defaultSource: 'src-1',
          grants: [],
          tools: [
            { name: 'read_file' },
            { name: 'write_file' },
            { name: 'artifact_link_file' },
          ] as any,
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

      // The build succeeds: posix names (read_file/write_file) are not
      // re-sent to the hub tool runner, so no duplicate-name collision is
      // raised when the runners are combined.
      expect(bundle.harness).toBeDefined();
    });
  });
});
