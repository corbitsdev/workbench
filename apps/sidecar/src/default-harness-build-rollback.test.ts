import { describe, it, expect, mock, beforeEach } from "bun:test";

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

// Records the order disposers actually run in, so the reverse-order
// assertion below is checking real call order, not a hand-fed value.
const disposeOrder: string[] = [];

// Toggled by the "throwing disposer" test: the tool-package disposer records
// its run then throws, proving the reverse-walk keeps going (posix+mail still
// disposed) and the ORIGINAL build error — not the disposer error — is rethrown.
let throwInToolPackageDispose = false;

const disposeSpy = mock(async () => {
  disposeOrder.push("tool-package");
  if (throwInToolPackageDispose) {
    throw new Error("tool-package disposer blew up");
  }
});

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

// Toggled by the "throw between tool-load and createHarness" test to prove
// the widened try region (CL-2814) still disposes what was materialized when
// the failure happens before createHarness is ever reached.
let throwInMergeToolRunners = false;
// Toggled by the "loadToolPackages throws" test to prove the try now opens
// BEFORE loadToolPackages, so posix+mail (already pushed to cleanup) are
// disposed even though no tool package ever materialized.
let throwInLoadToolPackages = false;

mock.module("./agent-tools", () => ({
  loadToolPackages: mock(async () => {
    if (throwInLoadToolPackages) {
      throw new Error("loadToolPackages manifest integrity failure");
    }
    return [{ factories: [toolFactory] }];
  }),
  fetchToolCredentials: mock(async () => ({})),
  mergeToolRunners: (
    runners: Array<{ definitions?: Array<{ name: string }> }>,
  ) => {
    if (throwInMergeToolRunners) {
      throw new Error("mergeToolRunners exploded pre-createHarness");
    }
    return {
      definitions: runners.flatMap((r) => r.definitions ?? []),
      run: mock(async () => ({ callId: "x", content: "" })),
    };
  },
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
    dispose: mock(async () => {
      disposeOrder.push("posix");
    }),
    run: mock(async () => ({ callId: "x", content: "" })),
  })),
}));

mock.module("@intx/tools-mail", () => ({
  createMailTools: mock(() => ({
    definitions: [{ name: "send_mail" }],
    dispose: mock(async () => {
      disposeOrder.push("mail");
    }),
    resetOutboundBudget: mock(() => {}),
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

function buildArgs() {
  return {
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
  };
}

describe("build() rollback (CL-2813, CL-2814)", () => {
  beforeEach(() => {
    disposeOrder.length = 0;
    throwInMergeToolRunners = false;
    throwInLoadToolPackages = false;
    throwInToolPackageDispose = false;
  });

  function makeBuilder() {
    return createDefaultHarnessBuilder({
      hubHttpUrl: "http://localhost:4000",
      sidecarToken: "test-token",
      cacheRoot: "/tmp/wb-test-tool-cache",
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
      adapters: createBuiltinRegistry(),
      gcPolicy: TEST_GC_POLICY,
    });
  }

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

    const buildPromise = builder.build(buildArgs());

    await expect(buildPromise).rejects.toThrow("has been deregistered");
    // The leak fix: the loaded tool package's disposer ran during rollback.
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("disposes in reverse allocation order: posix, mail, then tool-package", async () => {
    // Allocation order in build() is posixTools, then mailTools, then the
    // tool-package factory loop — so a reverse-order stack must dispose
    // tool-package first, then mail, then posix.
    const builder = createDefaultHarnessBuilder({
      hubHttpUrl: "http://localhost:4000",
      sidecarToken: "test-token",
      cacheRoot: "/tmp/wb-test-tool-cache",
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
      adapters: createBuiltinRegistry(),
      gcPolicy: TEST_GC_POLICY,
    });

    await expect(builder.build(buildArgs())).rejects.toThrow(
      "has been deregistered",
    );

    expect(disposeOrder).toEqual(["tool-package", "mail", "posix"]);
  });

  it("still disposes tool packages when the failure happens before createHarness is reached", async () => {
    // Forces the failure inside mergeToolRunners, which runs AFTER the
    // tool-load loop but BEFORE createHarness. Before CL-2814 this span ran
    // outside the try block, so a throw here bypassed rollback entirely and
    // leaked every already-materialized tool package.
    throwInMergeToolRunners = true;

    const builder = createDefaultHarnessBuilder({
      hubHttpUrl: "http://localhost:4000",
      sidecarToken: "test-token",
      cacheRoot: "/tmp/wb-test-tool-cache",
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
      adapters: createBuiltinRegistry(),
      gcPolicy: TEST_GC_POLICY,
    });

    await expect(builder.build(buildArgs())).rejects.toThrow(
      "mergeToolRunners exploded pre-createHarness",
    );

    expect(disposeOrder).toEqual(["tool-package", "mail", "posix"]);
  });

  it("disposes posix+mail when loadToolPackages throws before any tool package materializes", async () => {
    // loadToolPackages is a documented HARD-throw gate (manifest integrity)
    // that runs AFTER posix/mail are pushed to cleanup but BEFORE the try
    // opened at the old (post-tool-load) position. The try now opens right
    // after `const cleanup`, so this throw still disposes posix+mail. No tool
    // package ever materializes here, so only those two disposers run.
    throwInLoadToolPackages = true;

    const builder = makeBuilder();

    await expect(builder.build(buildArgs())).rejects.toThrow(
      "loadToolPackages manifest integrity failure",
    );

    // No "tool-package" entry: the tool-package disposer never ran because no
    // package materialized before loadToolPackages threw.
    expect(disposeOrder).toEqual(["mail", "posix"]);
  });

  it("continues the reverse-walk past a throwing disposer and rethrows the original build error", async () => {
    // The tool-package disposer throws during rollback. The reverse-walk must
    // still dispose mail and posix, and build() must reject with the ORIGINAL
    // createHarness error — never the disposer's error.
    throwInToolPackageDispose = true;

    const builder = makeBuilder();

    await expect(builder.build(buildArgs())).rejects.toThrow(
      "has been deregistered",
    );

    expect(disposeOrder).toEqual(["tool-package", "mail", "posix"]);
  });
});
