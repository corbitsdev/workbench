import { describe, it, expect, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition, ToolRunner } from "@intx/types/runtime";

// Seam test for exposure persistence across harness rebuilds: an idle-evicted
// session's harness is rebuilt from scratch, and previously loaded dynamic
// tools must survive via the persisted exposure file under storeDir. We drive
// the REAL build() (storage mocked, tools-catalog real) and assert on the
// exposure state handed to the director env, plus the on-disk persistence
// after a live load_tools call.

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
import {
  DYNAMIC_TOOLS_ENV_KEY,
  LOAD_TOOLS_NAME,
  persistExposure,
  readPersistedExposure,
} from "@workbench/tools-catalog";
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
  behavior: () => { definitions: { name: string }[] },
) {
  return Object.assign(behavior, { id, requires: [] as string[] });
}

function toolGrants(llmNames: string[]): unknown[] {
  return llmNames.map((name) => ({
    id: `grant-${name}`,
    resource: `tool:${name}`,
    action: "invoke",
    effect: "allow",
    conditions: null,
  }));
}

type BuildResult = {
  def: { toolFactories: readonly ((env: unknown) => DefinedRunner)[] };
  env: Record<string, unknown>;
};

async function buildMyra(
  storeDir: string,
  grantedLlmToolNames: string[],
): Promise<BuildResult> {
  createHarnessMock.mockClear();
  readDeployTreeMock.mockImplementationOnce(async () => ({
    systemPrompt: buildPersonalAgentSystemPrompt("Myra", { xml: true }),
  }));
  loadToolPackagesMock.mockImplementationOnce(async () => [
    {
      factories: [
        fakeFactory("@workbench/tools-fileparser/fileparser", () => ({
          definitions: [{ name: "fileparser__parse_file" }],
        })),
      ],
    },
  ]);
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
      tools: [{ name: "mail_send", description: "", inputSchema: {} }],
      principalId: "user-1",
      tenantId: "tenant-1",
      systemPrompt: "unused fallback",
    },
    sources: [validSource],
    defaultSource: validSource.id,
    storeDir,
    agentTransport: {} as never,
    crypto: { signSSH: mock(() => "sig") } as never,
    onEvent: mock(() => {}),
    onConnectorStateChanged: mock(() => {}),
  } as never);
  const callArgs = createHarnessMock.mock.calls[0] as unknown as [
    BuildResult["def"],
    Record<string, unknown>,
  ];
  return { def: callArgs[0], env: callArgs[1] };
}

async function makeStoreDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "wb-harness-exposure-"));
}

async function waitForPersisted(dir: string): Promise<string[]> {
  for (let i = 0; i < 50; i += 1) {
    const { exposed } = await readPersistedExposure(dir);
    if (exposed.length > 0) return exposed;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { exposed } = await readPersistedExposure(dir);
  return exposed;
}

describe("dynamic tool exposure persistence across harness rebuilds", () => {
  it("rehydrates persisted exposure, filtered to catalogued loaded tools", async () => {
    const storeDir = await makeStoreDir();
    try {
      await persistExposure(
        storeDir,
        new Set(["fileparser__parse_file", "linear__search", "ghost__tool"]),
      );
      // linear__search is granted (so catalogued) but its package never
      // loaded — a credential-less tool must not be rehydrated dead.
      const { env } = await buildMyra(storeDir, [
        "fileparser__parse_file",
        "linear__search",
      ]);
      const dynamic = env[DYNAMIC_TOOLS_ENV_KEY] as {
        exposure: { exposed: Set<string> };
      };
      expect(dynamic.exposure.exposed).toEqual(
        new Set(["fileparser__parse_file"]),
      );
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("a corrupt exposure file does not fail the build and rehydrates empty", async () => {
    const storeDir = await makeStoreDir();
    try {
      await fs.promises.writeFile(
        path.join(storeDir, "tool-exposure.json"),
        "not json{{",
      );
      const { env } = await buildMyra(storeDir, ["fileparser__parse_file"]);
      const dynamic = env[DYNAMIC_TOOLS_ENV_KEY] as {
        exposure: { exposed: Set<string> };
      };
      expect(dynamic.exposure.exposed).toEqual(new Set());
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("persists exposure to storeDir when load_tools exposes a tool", async () => {
    const storeDir = await makeStoreDir();
    try {
      const { def } = await buildMyra(storeDir, ["fileparser__parse_file"]);
      const factory = def.toolFactories[0];
      if (factory === undefined) throw new Error("no tool factory on def");
      const tools = factory({});
      const result = await tools.run(
        {
          id: "c1",
          name: LOAD_TOOLS_NAME,
          arguments: { names: ["fileparser__parse_file"] },
        },
        new AbortController().signal,
      );
      expect(result.isError).toBeUndefined();
      const persisted = await waitForPersisted(storeDir);
      expect(persisted).toEqual(["fileparser__parse_file"]);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });
});
