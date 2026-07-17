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

// Grant rows in the exact shape the hub persists (`buildToolGrantRows`):
// resource `tool:<llm-safe name>`, action `invoke`. The catalog gate must
// authorize against THESE — not `agentConfig.tools`, whose hub-proxy
// definitions carry bare names and omit package tools entirely (CL-3825).
function toolGrants(llmNames: string[]): unknown[] {
  return llmNames.map((name) => ({
    id: `grant-${name}`,
    resource: `tool:${name}`,
    action: "invoke",
    effect: "allow",
    conditions: null,
  }));
}

type BuiltTools = {
  definitions: { name: string }[];
  run: (
    call: { id: string; name: string; arguments: unknown },
    signal?: AbortSignal,
  ) => Promise<{ callId: string; content: unknown; isError?: boolean }>;
};

type BuiltHarness = {
  def: { toolFactories: readonly ((env: unknown) => BuiltTools)[] };
  env: Record<string, unknown>;
};

async function buildAgent(
  grantedLlmToolNames: string[],
  options: { dynamicCatalog: boolean },
): Promise<BuiltHarness> {
  createHarnessMock.mockClear();
  readDeployTreeMock.mockImplementationOnce(async () => ({
    systemPrompt: options.dynamicCatalog
      ? buildPersonalAgentSystemPrompt("Myra", { xml: true })
      : "You are a workflow step agent.",
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
      grants: toolGrants(grantedLlmToolNames) as never,
      // Hub-real shape: `config.tools` holds only hub-proxy/local definitions
      // under their BARE names; package tools never appear here (they arrive
      // via toolPackagePins). The pre-CL-3825 gate read these names and so
      // never intersected the safe-form catalog — the corpus collapsed empty.
      tools: [{ name: "mail_send", description: "", inputSchema: {} }],
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
    BuiltHarness["def"],
    Record<string, unknown>,
  ];
  return { def: callArgs[0], env: callArgs[1] };
}

async function buildMyra(
  grantedLlmToolNames: string[] = [],
): Promise<Record<string, unknown>> {
  const built = await buildAgent(grantedLlmToolNames, {
    dynamicCatalog: true,
  });
  return built.env;
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

describe("dispatch allow-list: granted loaded package tools survive the filter", () => {
  const signal = new AbortController().signal;

  function toolsFrom(def: BuiltHarness["def"]): BuiltTools {
    const factory = def.toolFactories[0];
    if (factory === undefined)
      throw new Error("harness def has no tool factory");
    return factory({});
  }

  function loadedFactory(
    id: string,
    toolNames: string[],
    run: (call: { id: string; name: string }) => Promise<{
      callId: string;
      content: unknown;
    }>,
  ) {
    return Object.assign(
      () => ({ definitions: toolNames.map((name) => ({ name })), run }),
      { id, requires: [] as string[] },
    );
  }

  it("keeps a granted loaded catalog tool advertised and dispatchable after load_tools", async () => {
    const packageRun = mock(
      async (call: {
        id: string;
        name: string;
      }): Promise<{
        callId: string;
        content: unknown;
      }> => ({ callId: call.id, content: { parsed: true } }),
    );
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          loadedFactory(
            "@workbench/tools-fileparser/fileparser",
            ["fileparser__parse_file"],
            packageRun,
          ),
        ],
      },
    ]);

    const { def, env } = await buildAgent(["fileparser__parse_file"], {
      dynamicCatalog: true,
    });
    const tools = toolsFrom(def);

    const names = tools.definitions.map((d) => d.name);
    expect(names).toContain("fileparser__parse_file");

    const loadResult = await tools.run(
      {
        id: "call-load",
        name: "load_tools",
        arguments: { names: ["fileparser__parse_file"] },
      },
      signal,
    );
    expect(loadResult.isError).not.toBe(true);
    const dynamic = env[DYNAMIC_TOOLS_ENV_KEY] as {
      exposure: { exposed: Set<string> };
    };
    expect(dynamic.exposure.exposed.has("fileparser__parse_file")).toBe(true);

    const callResult = await tools.run(
      { id: "call-1", name: "fileparser__parse_file", arguments: {} },
      signal,
    );
    expect(callResult.isError).not.toBe(true);
    expect(packageRun).toHaveBeenCalledTimes(1);
  });

  it("still rejects a loaded catalog tool the member is not granted", async () => {
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          loadedFactory(
            "@workbench/tools-fileparser/fileparser",
            ["fileparser__parse_file"],
            async (call) => ({ callId: call.id, content: {} }),
          ),
          loadedFactory(
            "@workbench/tools-linear/linear",
            ["linear__search"],
            async (call) => ({ callId: call.id, content: {} }),
          ),
        ],
      },
    ]);

    const { def } = await buildAgent(["fileparser__parse_file"], {
      dynamicCatalog: true,
    });
    const tools = toolsFrom(def);

    const names = tools.definitions.map((d) => d.name);
    expect(names).toContain("fileparser__parse_file");
    expect(names).not.toContain("linear__search");

    const rejected = await tools.run(
      { id: "call-2", name: "linear__search", arguments: {} },
      signal,
    );
    expect(rejected.isError).toBe(true);
  });

  it("admits every loaded tool for an agent without a dynamic catalog", async () => {
    const packageRun = mock(
      async (call: {
        id: string;
        name: string;
      }): Promise<{
        callId: string;
        content: unknown;
      }> => ({ callId: call.id, content: { ok: true } }),
    );
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          loadedFactory(
            "@workbench/tools-granola/granola",
            ["granola__list_calls"],
            packageRun,
          ),
        ],
      },
    ]);

    const { def } = await buildAgent([], { dynamicCatalog: false });
    const tools = toolsFrom(def);

    expect(tools.definitions.map((d) => d.name)).toContain(
      "granola__list_calls",
    );
    const callResult = await tools.run(
      { id: "call-3", name: "granola__list_calls", arguments: {} },
      signal,
    );
    expect(callResult.isError).not.toBe(true);
    expect(packageRun).toHaveBeenCalledTimes(1);
  });
});
