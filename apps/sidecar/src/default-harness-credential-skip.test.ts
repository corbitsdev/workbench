// A tenant that hasn't configured an optional tool provider (e.g. notion)
// should not WARN on every agent launch — that's expected, not a fault.
// getToolCredential throws ToolCredentialMissingError when the env key is
// entirely absent; the harness must detect it via `err.name` (tool packages
// load from published tarballs, so `instanceof` can miss across bundle
// copies of the class) and log at info, not warn. A malformed credential
// (present but invalid) is still a wiring fault and must still warn.
//
// default-harness.ts binds its module-level `logger` const at import time
// (`const logger = getLogger([...])`), so mocking `@intx/log` via
// `mock.module` cannot intercept it here: a static import of this module is
// hoisted ahead of any mock.module registration, so the constant is already
// bound to the real logger before a mock could apply. `@logtape/logtape`'s
// `getLogger` memoizes one Logger instance per category array, so this
// spies on the SAME instance the harness holds by fetching it under the
// identical category and using `spyOn` instead of replacing the module.
//
// mock.module is process-global (for the other mocked modules below); this
// file must run under `bun test --isolate`.

import { describe, it, expect, mock, spyOn } from "bun:test";
import { getLogger } from "@intx/log";
import { ToolCredentialMissingError } from "@workbench/tool-credentials";

const logger = getLogger(["sidecar", "harness-builder"]);
// logtape's warn/info are heavily overloaded (some overloads return a Promise),
// so a bare `() => {}` is not assignable to the method type; the spy only needs
// a silent no-op, so bridge the impl to the method signature.
const silentLog = (() => {}) as unknown as typeof logger.warn;
const warnSpy = spyOn(logger, "warn").mockImplementation(silentLog);
const infoSpy = spyOn(logger, "info").mockImplementation(silentLog);

const createIsogitStoreMock = mock(async () => ({
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

const createHarnessMock = mock(async () => ({
  type: "harness",
  async *stream() {},
  async close() {},
}));

mock.module("@intx/harness", () => ({
  createHarness: createHarnessMock,
  createHarnessRuntimeCapabilities: mock(() => ({
    resolve: mock(() => ({ type: "mock-transport" })),
  })),
}));

const readDeployTreeMock = mock(async () => ({
  systemPrompt: undefined as string | undefined,
}));
mock.module("@workbench/hub-agent", () => ({
  readDeployTree: readDeployTreeMock,
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

const loadToolPackagesMock = mock(async (): Promise<unknown[]> => []);

mock.module("./agent-tools", () => ({
  loadToolPackages: loadToolPackagesMock,
  fetchToolCredentials: mock(async () => ({})),
  mergeToolRunners: () => ({
    definitions: [],
    async run() {
      return { callId: "x", content: "" };
    },
  }),
  filterToolRunner: (runner: unknown) => runner,
  wsUrlToHttp: (u: string) => u,
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

function fakeFactory(id: string, behavior: () => never) {
  return Object.assign(behavior, { id, requires: [] as string[] });
}

async function buildAgentEnv(): Promise<void> {
  createHarnessMock.mockClear();
  const builder = createDefaultHarnessBuilder({
    hubHttpUrl: "http://localhost:4000",
    sidecarToken: "test-token",
    cacheRoot: "/tmp/wb-test-tool-cache",
    cacheMaxBytes: 1024 * 1024,
    registryMaxTarballBytes: 1024 * 1024,
    adapters: createBuiltinRegistry(),
    gcPolicy: TEST_GC_POLICY,
  });
  await builder.build({
    agentAddress: "oat@tenant.localhost",
    agentConfig: {
      agentAddress: "oat@tenant.localhost",
      agentId: "agent-1",
      sessionId: "session-1",
      sources: [validSource],
      defaultSource: "src-1",
      grants: [],
      tools: [],
      principalId: "user-1",
      tenantId: "tenant-1",
      systemPrompt: "unused fallback",
    },
    sources: [validSource],
    defaultSource: validSource.id,
    storeDir: "/tmp/test-store",
    agentTransport: {} as never,
    crypto: { signSSH: mock(() => "sig") } as never,
    onEvent: mock(() => {}),
    onConnectorStateChanged: mock(() => {}),
  });
}

describe("default harness: missing-credential skip is quiet", () => {
  it("a factory throwing ToolCredentialMissingError is skipped at info level, not warn", async () => {
    warnSpy.mockClear();
    infoSpy.mockClear();
    loadToolPackagesMock.mockReset();
    loadToolPackagesMock.mockImplementation(async () => [
      {
        factories: [
          fakeFactory("@workbench/tools-notion/notion", () => {
            throw new ToolCredentialMissingError("notion");
          }),
        ],
      },
    ]);

    await buildAgentEnv();
    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("failed to construct"))).toBe(
      false,
    );
    const skipCall = infoSpy.mock.calls.find((c) =>
      String(c[0]).includes("no credential configured"),
    );
    expect(skipCall).toBeTruthy();
    const fields = (skipCall as unknown[] | undefined)?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(fields?.providerName).toBe("notion");
  });

  it("a factory throwing a generic Error still warns", async () => {
    warnSpy.mockClear();
    infoSpy.mockClear();
    loadToolPackagesMock.mockReset();
    loadToolPackagesMock.mockImplementation(async () => [
      {
        factories: [
          fakeFactory("@workbench/tools-notion/notion", () => {
            throw new Error("Notion credential malformed");
          }),
        ],
      },
    ]);

    await buildAgentEnv();

    const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("failed to construct"))).toBe(
      true,
    );
    const infoMessages = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(
      infoMessages.some((m) => m.includes("no credential configured")),
    ).toBe(false);
  });
});
