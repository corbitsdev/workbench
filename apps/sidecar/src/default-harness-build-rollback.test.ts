import { describe, it, expect, mock } from "bun:test";

// CL-2813 regression: when build() fails after materializing the agent's tool
// packages (e.g. `createHarness` throws because the address was deregistered
// mid-reconnect), the builder MUST dispose the loaded tool packages before it
// rethrows. Those disposers hold connections/watchers the GC cannot reclaim, so
// a leaked one accumulates a full tool-package graph on every failed restore —
// the root cause of the staging sidecar's 6GB heap. startSession's catch cannot
// clean this up: build() never returned a bundle, so there are no disposers to
// call. The contract (packages/hub-agent/src/harness-builder.ts) is that the
// builder rolls back what it allocated.
//
// This lives in its own file because it fully mocks `./agent-tools` (to inject a
// tool package with a disposer spy and force a build failure), which would
// otherwise clobber the wsUrlToHttp/success-path assertions in
// default-harness.test.ts. mock.module is process-global per file under
// --isolate, so isolation keeps the two mock surfaces from colliding.

const disposeSpy = mock(async () => {});

// A single tool-package factory: callable(env) -> bundle with a disposer, plus
// the loader-facing `id`/`requires` metadata build() reads before instantiating.
const toolFactory = Object.assign(
  (_env: unknown) => ({
    definitions: [{ name: "test_tool" }],
    run: mock(async () => ({ callId: "x", content: "" })),
    dispose: disposeSpy,
  }),
  { id: "@workbench/tools-test/test", requires: [] as string[] },
);

mock.module("./agent-tools", () => ({
  loadToolPackages: mock(async () => [{ factories: [toolFactory] }]),
  fetchToolCredentials: mock(async () => ({})),
  mergeToolRunners: (
    runners: Array<{ definitions?: Array<{ name: string }> }>,
  ) => ({
    definitions: runners.flatMap((r) => r.definitions ?? []),
    run: mock(async () => ({ callId: "x", content: "" })),
  }),
  filterToolRunner: (runner: unknown) => runner,
  wsUrlToHttp: (u: string) => u,
}));

const createIsogitStoreMock = mock(async (..._args: unknown[]) => ({
  type: "isogit",
  load: mock(async () => ({
    turns: [],
    pendingOperations: [],
    tokenUsage: {},
    connectorState: null,
  })),
  writeTurns: mock(async () => {}),
  commit: mock(async () => ({})),
}));

mock.module("@workbench/storage-isogit", () => ({
  createIsogitStore: createIsogitStoreMock,
  createMailAuditStore: mock(async () => ({ type: "mail-audit" })),
}));

// The build failure under test: createHarness throws after the tool packages
// have already been materialized (their disposers collected).
mock.module("@intx/harness", () => ({
  createHarness: mock(async () => {
    throw new Error("Address agent@tenant.localhost has been deregistered");
  }),
  createHarnessRuntimeCapabilities: mock(() => ({
    resolve: mock(() => ({ type: "mock-transport" })),
  })),
}));

mock.module("@workbench/hub-agent", () => ({
  readDeployTree: mock(async () => ({
    systemPrompt: undefined as string | undefined,
  })),
}));

mock.module("@intx/tools-posix", () => ({
  createPosixTools: mock(() => ({
    definitions: [{ name: "read_file" }],
    dispose: mock(async () => {}),
    run: mock(async () => ({ callId: "x", content: "" })),
  })),
}));

mock.module("@intx/authz", () => ({
  evaluateGrants: mock(async () => {}),
}));

mock.module("@intx/types/runtime", () => ({
  createBlobReader: mock(() => ({})),
}));

import { createDefaultHarnessBuilder } from "./default-harness";
import { createBuiltinRegistry } from "@intx/inference/providers";
import type { InferenceSource } from "@intx/types/runtime";

const validSource: InferenceSource = {
  id: "src-1",
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "test-key",
  model: "gpt-4o",
};

const TEST_GC_POLICY = {
  packThreshold: 3,
  looseThreshold: 7,
  warnBytes: 1024,
  retention: "tip-only",
} as const;

describe("build() rollback (CL-2813)", () => {
  it("disposes materialized tool packages when the build fails", async () => {
    const builder = createDefaultHarnessBuilder({
      hubHttpUrl: "http://localhost:4000",
      sidecarToken: "test-token",
      cacheRoot: "/tmp/wb-test-tool-cache",
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
      adapters: createBuiltinRegistry(),
      gcPolicy: TEST_GC_POLICY,
    });

    const buildPromise = builder.build({
      agentAddress: "agent@tenant.localhost",
      agentConfig: {
        agentAddress: "agent@tenant.localhost",
        agentId: "agent-1",
        sessionId: "session-1",
        sources: [validSource],
        defaultSource: "src-1",
        grants: [],
        tools: [],
        principalId: "user-1",
        tenantId: "tenant-1",
        systemPrompt: "You are a helpful assistant.",
      },
      sources: [validSource],
      defaultSource: validSource.id,
      storeDir: "/tmp/test-store",
      agentTransport: {} as never,
      crypto: { signSSH: mock(() => "sig") } as never,
      onEvent: mock(() => {}),
      onConnectorStateChanged: mock(() => {}),
    });

    await expect(buildPromise).rejects.toThrow("has been deregistered");
    // The leak fix: the loaded tool package's disposer ran during rollback.
    expect(disposeSpy).toHaveBeenCalled();
  });
});
