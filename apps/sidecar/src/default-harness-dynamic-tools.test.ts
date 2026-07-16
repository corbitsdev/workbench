import { describe, it, expect, mock } from "bun:test";
import type { ToolDefinition, ToolRunner } from "@intx/types/runtime";

// Seam test for the credential-gate on Myra's dynamic tool catalog: a catalog
// package whose factory fails to construct (e.g. a missing tenant credential,
// which the harness drops fail-soft) must not be advertised to the model —
// neither in the director's env catalog nor via search_tools. We drive the
// REAL build() and assert on the env handed to createHarness.

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

// Mock the tool-package/credential boundary. loadToolPackages is overridable
// per test. mergeToolRunners/filterToolRunner are re-implemented here (small,
// stable helpers) so the merge/filter shape runs rather than being stubbed
// out — but this is a copy, so a divergence in the production helpers would not
// be caught here; the real helpers are tested in default-harness.test.ts
// (the combineRunners suite).
type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };
const loadToolPackagesMock = mock(async (): Promise<unknown[]> => []);

function mergeToolRunners(runners: ToolRunner[]): DefinedRunner {
  const allDefinitions = runners.flatMap(
    (r) => (r as DefinedRunner).definitions ?? [],
  );
  const toolToRunner = new Map<string, ToolRunner>();
  for (const runner of runners) {
    for (const def of (runner as DefinedRunner).definitions ?? []) {
      toolToRunner.set(def.name, runner);
    }
  }
  return {
    definitions: allDefinitions,
    async run(call, signal) {
      const runner = toolToRunner.get(call.name);
      if (!runner) {
        return {
          callId: call.id,
          content: { error: `Tool "${call.name}" is not available` },
          isError: true,
        };
      }
      return runner.run(call, signal);
    },
  };
}

function filterToolRunner(
  runner: DefinedRunner,
  allowedNames: Set<string>,
): DefinedRunner {
  return {
    definitions: runner.definitions.filter((d) => allowedNames.has(d.name)),
    async run(call, signal) {
      if (!allowedNames.has(call.name)) {
        return {
          callId: call.id,
          content: {
            error: `Tool "${call.name}" is not enabled for this agent`,
          },
          isError: true,
        };
      }
      return runner.run(call, signal);
    },
  };
}

mock.module("./agent-tools", () => ({
  loadToolPackages: loadToolPackagesMock,
  fetchToolCredentials: mock(async () => ({})),
  mergeToolRunners,
  filterToolRunner,
  wsUrlToHttp: (u: string) => u,
}));

import { createDefaultHarnessBuilder } from "./default-harness";
import { buildPersonalAgentSystemPrompt } from "@workbench/myra";
import { DYNAMIC_TOOLS_ENV_KEY } from "@workbench/tools-catalog";
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

function fakeFactory(
  id: string,
  behavior: () => { definitions: { name: string }[] } | never,
) {
  return Object.assign(behavior, { id, requires: [] as string[] });
}

async function buildMyra(
  grantedToolNames: string[] = [],
): Promise<Record<string, unknown>> {
  createHarnessMock.mockClear();
  readDeployTreeMock.mockImplementationOnce(async () => ({
    systemPrompt: buildPersonalAgentSystemPrompt("Myra", { xml: true }),
  }));
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
    agentAddress: "myra@tenant.localhost",
    agentConfig: {
      agentAddress: "myra@tenant.localhost",
      agentId: "agent-1",
      sessionId: "session-1",
      sources: [validSource],
      defaultSource: "src-1",
      grants: [],
      tools: grantedToolNames.map((name) => ({
        name,
        description: "",
        inputSchema: {},
      })),
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
  const callArgs = createHarnessMock.mock.calls[0] as unknown as [
    unknown,
    Record<string, unknown>,
  ];
  return callArgs[1];
}

describe("dynamic tool catalog: full-catalog advertisement (CL-3795)", () => {
  it("advertises a granted catalog package even when its factory failed to construct", async () => {
    // fileparser (keyless) constructs; linear (credential missing) throws and
    // is dropped fail-soft. Both are still granted and catalogued, so
    // search_tools must advertise BOTH — the model should be able to discover
    // linear even though the package didn't load, rather than the CL-3133 gate
    // hiding it entirely.
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          fakeFactory("@workbench/tools-fileparser/fileparser", () => ({
            definitions: [{ name: "fileparser__parse_file" }],
          })),
          fakeFactory("@workbench/tools-linear/linear", () => {
            throw Object.assign(new Error("Linear apiKey is required"), {
              name: "ToolCredentialMissingError",
              providerName: "linear",
            });
          }),
        ],
      },
    ]);

    const env = await buildMyra(["fileparser__parse_file", "linear__search"]);
    const dynamic = env[DYNAMIC_TOOLS_ENV_KEY] as {
      catalog: { package: string }[];
    };
    const packages = dynamic.catalog.map((e) => e.package);
    expect(packages).toContain("fileparser");
    expect(packages).toContain("linear");
  });

  it("advertises no catalog packages when none of them are granted, regardless of load", async () => {
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          fakeFactory("@workbench/tools-fileparser/fileparser", () => ({
            definitions: [{ name: "fileparser__parse_file" }],
          })),
        ],
      },
    ]);
    const env = await buildMyra([]);
    const dynamic = env[DYNAMIC_TOOLS_ENV_KEY] as {
      catalog: { package: string }[];
    };
    expect(dynamic.catalog).toEqual([]);
  });
});
