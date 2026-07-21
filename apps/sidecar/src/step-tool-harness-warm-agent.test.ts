import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition, ToolRunner } from "@intx/types/runtime";

// Seam test for the WARM single-step agent path re-homed onto the step tool
// harness (interchange runtime-retirement pin bump): a single-step deployment
// (Myra) must resolve its per-agent director and get the dynamic tool catalog +
// persisted exposure wired exactly as the retired in-process `default-harness`
// did, while a genuine multi-step workflow step keeps the budget director and
// full tool advertisement. We drive the REAL `createStepAgentFactory` with a
// captured underlying agentFactory and assert on the step def + env it hands
// down, plus the on-disk exposure persistence.

type DefinedRunner = ToolRunner & { definitions: ToolDefinition[] };

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

const loadToolPackagesMock = mock(async (): Promise<unknown[]> => []);

mock.module("./agent-tools", () => ({
  loadToolPackages: loadToolPackagesMock,
  fetchToolCredentials: mock(async () => ({})),
  mergeToolRunners,
  filterToolRunner,
  wsUrlToHttp: (u: string) => u,
}));

import {
  createStepAgentFactory,
  selectDirectorId,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";
import {
  buildPersonalAgentSystemPrompt,
  withInvokeSessionMarker,
} from "@workbench/myra";
import {
  MYRA_TOOL_CATALOG,
  DYNAMIC_TOOLS_DIRECTOR_ID,
  TRIAGE_BUDGET_DIRECTOR_ID,
  INVOKE_BUDGET_DIRECTOR_ID,
  WORKFLOW_STEP_BUDGET_DIRECTOR_ID,
} from "@workbench/agents";
import {
  DYNAMIC_TOOLS_ENV_KEY,
  LOAD_TOOLS_NAME,
  catalogManagedNames,
  persistExposure,
  readPersistedExposure,
} from "@workbench/tools-catalog";

const MYRA_PROMPT = buildPersonalAgentSystemPrompt("Myra", { xml: true });
const MANAGED = [...catalogManagedNames(MYRA_TOOL_CATALOG)];
// Two real catalog-managed names to drive grant gating with.
const GRANTED = MANAGED[0] as string;
const UNGRANTED = MANAGED[1] as string;

const originalFetch = globalThis.fetch;
beforeEach(() => {
  // No hub manifest rail in-test: the manifest fetch returns non-ok so
  // buildStepTools falls back to the loadToolPackages mock's fake packages.
  globalThis.fetch = mock(async () => ({
    ok: false,
    status: 500,
  })) as unknown as typeof fetch;
  loadToolPackagesMock.mockReset();
  loadToolPackagesMock.mockImplementation(async () => []);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function toolGrants(
  llmNames: string[],
  effect: "allow" | "ask" = "allow",
): unknown[] {
  return llmNames.map((name) => ({
    id: `grant-${name}`,
    resource: `tool:${name}`,
    action: "invoke",
    effect,
    conditions: null,
  }));
}

/**
 * A loadToolPackages fake: one package whose factory produces a tool named
 * `toolName`, unless `throwCredential` is set (drops fail-soft like a missing
 * credential — catalogued but not loaded).
 */
function fakePackages(
  entries: {
    factoryId: string;
    toolName: string;
    throwCredential?: boolean;
    run?: (call: { id: string; name: string }) => Promise<{
      callId: string;
      content: unknown;
    }>;
  }[],
): unknown[] {
  return [
    {
      factories: entries.map((e) =>
        Object.assign(
          () => {
            if (e.throwCredential === true) {
              throw Object.assign(new Error(`${e.factoryId} credential`), {
                name: "ToolCredentialMissingError",
                providerName: e.factoryId,
              });
            }
            return {
              definitions: [{ name: e.toolName }],
              run:
                e.run ??
                (async (call: { id: string }) => ({
                  callId: call.id,
                  content: { ok: true },
                })),
            };
          },
          { id: e.factoryId, requires: [] as string[] },
        ),
      ),
    },
  ];
}

type Built = {
  stepDef: {
    director?: { id: string };
    toolFactories: readonly ((env: unknown) => DefinedRunner)[];
  };
  agentEnv: Record<string, unknown>;
  tools: DefinedRunner;
};

/** POSIX tool names that must never be advertised on the warm single-step path. */
const POSIX_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "search_files",
  "grep",
  "run_shell",
] as const;

async function buildWarmAgent(args: {
  systemPrompt: string;
  grantedLlmNames: string[];
  askLlmNames?: string[];
  warmKeep: boolean;
  storeDir: string;
  director?: { id: string; config: Record<string, unknown> };
  /**
   * When set, placed on the step env as `transport` so `buildStepTools`
   * injects mail tools (mirrors the workflow substrate mailbox path).
   */
  transport?: unknown;
}): Promise<Built> {
  let capturedDef: Built["stepDef"] | undefined;
  let capturedEnv: Record<string, unknown> | undefined;
  const factory = createStepAgentFactory({
    warmKeep: args.warmKeep,
    agentFactory: (async (def: unknown, env: unknown) => {
      capturedDef = def as Built["stepDef"];
      capturedEnv = env as Record<string, unknown>;
      return { send: async () => {}, close: async () => {} };
    }) as never,
  });

  const workdir = path.join(args.storeDir, "workspace");
  await fs.promises.mkdir(workdir, { recursive: true });

  const ctx: StepToolContext = {
    hubHttpUrl: "http://localhost:4000",
    sidecarToken: "test-token",
    tenantId: "tenant-1",
    stepAgentId: "ins_ses_1-step",
    stepAddress: "myra@tenant.localhost",
    principalId: "ins_ses_1-step",
    grants: [
      ...toolGrants(args.grantedLlmNames),
      ...toolGrants(args.askLlmNames ?? [], "ask"),
    ] as never,
    // loadToolPackages is module-mocked here; the on-disk read just needs a
    // valid dir (no deploy/ → undefined manifest, ignored by the mock).
    deployTreeDir: args.storeDir,
    cacheRoot: path.join(args.storeDir, "cache"),
    cacheMaxBytes: 1024 * 1024,
    registryMaxTarballBytes: 1024 * 1024,
  };

  const env: Record<string, unknown> = {
    sources: [],
    defaultSource: "src-1",
    storage: { type: "isogit" },
    workdir,
    audit: { type: "audit" },
    directors: {},
    authorize: async () => ({
      effect: null,
      matchingGrants: [],
      resolvedBy: null,
    }),
    [STEP_TOOL_CONTEXT_KEY]: ctx,
  };
  if (args.transport !== undefined) {
    env.transport = args.transport;
  }

  const def = {
    id: "agent-1",
    systemPrompt: args.systemPrompt,
    toolFactories: [],
    capabilities: [],
    inference: { sources: [] },
    ...(args.director !== undefined ? { director: args.director } : {}),
  };

  await factory(def as never, env as never);
  if (capturedDef === undefined || capturedEnv === undefined) {
    throw new Error("agentFactory was not invoked");
  }
  const toolFactory = capturedDef.toolFactories[0];
  if (toolFactory === undefined)
    throw new Error("step def has no tool factory");
  return {
    stepDef: capturedDef,
    agentEnv: capturedEnv,
    tools: toolFactory({}),
  };
}

async function makeStoreDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "wb-step-warm-"));
}

describe("selectDirectorId (re-homed from default-harness)", () => {
  it("prefers triage, then invoke, then dynamic, else default", () => {
    expect(
      selectDirectorId({
        isTriageSession: true,
        isInvokeSession: true,
        hasDynamicToolConfig: true,
      }),
    ).toBe(TRIAGE_BUDGET_DIRECTOR_ID);
    expect(
      selectDirectorId({
        isTriageSession: false,
        isInvokeSession: true,
        hasDynamicToolConfig: true,
      }),
    ).toBe(INVOKE_BUDGET_DIRECTOR_ID);
    expect(
      selectDirectorId({
        isTriageSession: false,
        isInvokeSession: false,
        hasDynamicToolConfig: true,
      }),
    ).toBe(DYNAMIC_TOOLS_DIRECTOR_ID);
    expect(
      selectDirectorId({
        isTriageSession: false,
        isInvokeSession: false,
        hasDynamicToolConfig: false,
      }),
    ).toBeUndefined();
  });
});

describe("warm single-step agent: director resolution", () => {
  it("resolves the personal agent's prompt to the dynamic-tools director", async () => {
    const storeDir = await makeStoreDir();
    try {
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
      });
      expect(built.stepDef.director?.id).toBe(DYNAMIC_TOOLS_DIRECTOR_ID);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("resolves an invoke-marked prompt to the invoke budget director (priority over dynamic)", async () => {
    const storeDir = await makeStoreDir();
    try {
      const built = await buildWarmAgent({
        systemPrompt: withInvokeSessionMarker(MYRA_PROMPT),
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
      });
      expect(built.stepDef.director?.id).toBe(INVOKE_BUDGET_DIRECTOR_ID);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("falls back to the registry default (no director) for a plain agent prompt", async () => {
    const storeDir = await makeStoreDir();
    try {
      const built = await buildWarmAgent({
        systemPrompt: "You are a helpful assistant.",
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
      });
      expect(built.stepDef.director).toBeUndefined();
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("respects a director declared on the definition", async () => {
    const storeDir = await makeStoreDir();
    try {
      const built = await buildWarmAgent({
        systemPrompt: "You are a helpful assistant.",
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
        director: { id: "@vendor/custom", config: {} },
      });
      expect(built.stepDef.director?.id).toBe("@vendor/custom");
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("pins a genuine multi-step step to the budget director even for the personal agent prompt", async () => {
    const storeDir = await makeStoreDir();
    try {
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [],
        warmKeep: false,
        storeDir,
      });
      expect(built.stepDef.director?.id).toBe(WORKFLOW_STEP_BUDGET_DIRECTOR_ID);
      // A multi-step step never carries the dynamic-tools env.
      expect(built.agentEnv[DYNAMIC_TOOLS_ENV_KEY]).toBeUndefined();
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });
});

describe("warm single-step agent: dynamic tool catalog + gating", () => {
  it("advertises a granted catalog package even when its factory failed to construct", async () => {
    const storeDir = await makeStoreDir();
    try {
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          { factoryId: "@workbench/tools-a/a", toolName: GRANTED },
          {
            factoryId: "@workbench/tools-b/b",
            toolName: UNGRANTED,
            throwCredential: true,
          },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [GRANTED, UNGRANTED],
        warmKeep: true,
        storeDir,
      });
      const dynamic = built.agentEnv[DYNAMIC_TOOLS_ENV_KEY] as {
        catalog: unknown[];
      };
      const managed = catalogManagedNames(dynamic.catalog as never);
      expect(managed.has(GRANTED)).toBe(true);
      expect(managed.has(UNGRANTED)).toBe(true);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("advertises a catalog package granted with the 'ask' effect (native-approvals)", async () => {
    // An `ask` grant authorizes the tool — it just suspends the call for human
    // approval at invoke time. The catalog gate must treat `ask` as granted, or
    // a write tool would silently vanish from the dynamic catalog the moment the
    // native-approvals feature flips its grant from allow to ask.
    const storeDir = await makeStoreDir();
    try {
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          { factoryId: "@workbench/tools-a/a", toolName: GRANTED },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [],
        askLlmNames: [GRANTED],
        warmKeep: true,
        storeDir,
      });
      const dynamic = built.agentEnv[DYNAMIC_TOOLS_ENV_KEY] as {
        catalog: unknown[];
      };
      const managed = catalogManagedNames(dynamic.catalog as never);
      expect(managed.has(GRANTED)).toBe(true);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("advertises no catalog packages when none are granted, regardless of load", async () => {
    const storeDir = await makeStoreDir();
    try {
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          { factoryId: "@workbench/tools-a/a", toolName: GRANTED },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
      });
      const dynamic = built.agentEnv[DYNAMIC_TOOLS_ENV_KEY] as {
        catalog: unknown[];
      };
      expect(dynamic.catalog).toEqual([]);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("keeps a granted loaded catalog tool advertised and dispatchable after load_tools", async () => {
    const storeDir = await makeStoreDir();
    try {
      const packageRun = mock(async (call: { id: string }) => ({
        callId: call.id,
        content: { parsed: true },
      }));
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          {
            factoryId: "@workbench/tools-a/a",
            toolName: GRANTED,
            run: packageRun,
          },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [GRANTED],
        warmKeep: true,
        storeDir,
      });
      const signal = new AbortController().signal;
      expect(built.tools.definitions.map((d) => d.name)).toContain(GRANTED);

      const loadResult = await built.tools.run(
        {
          id: "call-load",
          name: LOAD_TOOLS_NAME,
          arguments: { names: [GRANTED] },
        },
        signal,
      );
      expect(loadResult.isError).not.toBe(true);
      const dynamic = built.agentEnv[DYNAMIC_TOOLS_ENV_KEY] as {
        exposure: { exposed: Set<string> };
      };
      expect(dynamic.exposure.exposed.has(GRANTED)).toBe(true);

      const callResult = await built.tools.run(
        { id: "call-1", name: GRANTED, arguments: {} },
        signal,
      );
      expect(callResult.isError).not.toBe(true);
      expect(packageRun).toHaveBeenCalledTimes(1);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("rejects a loaded catalog tool the member is not granted", async () => {
    const storeDir = await makeStoreDir();
    try {
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          { factoryId: "@workbench/tools-a/a", toolName: GRANTED },
          { factoryId: "@workbench/tools-b/b", toolName: UNGRANTED },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [GRANTED],
        warmKeep: true,
        storeDir,
      });
      const names = built.tools.definitions.map((d) => d.name);
      expect(names).toContain(GRANTED);
      expect(names).not.toContain(UNGRANTED);

      const rejected = await built.tools.run(
        { id: "call-2", name: UNGRANTED, arguments: {} },
        new AbortController().signal,
      );
      expect(rejected.isError).toBe(true);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("admits every loaded tool for a warm agent without a dynamic catalog", async () => {
    const storeDir = await makeStoreDir();
    try {
      const packageRun = mock(async (call: { id: string }) => ({
        callId: call.id,
        content: { ok: true },
      }));
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          {
            factoryId: "@workbench/tools-a/a",
            toolName: "granola__list_calls",
            run: packageRun,
          },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: "You are a helpful assistant.",
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
      });
      expect(built.tools.definitions.map((d) => d.name)).toContain(
        "granola__list_calls",
      );
      const callResult = await built.tools.run(
        { id: "call-3", name: "granola__list_calls", arguments: {} },
        new AbortController().signal,
      );
      expect(callResult.isError).not.toBe(true);
      expect(packageRun).toHaveBeenCalledTimes(1);
      expect(built.agentEnv[DYNAMIC_TOOLS_ENV_KEY]).toBeUndefined();
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });
});

describe("warm single-step agent: exposure persistence across rebuilds", () => {
  it("rehydrates persisted exposure, filtered to catalogued loaded tools", async () => {
    const storeDir = await makeStoreDir();
    try {
      await persistExposure(
        storeDir,
        new Set([GRANTED, UNGRANTED, "ghost__tool"]),
      );
      // UNGRANTED is granted (so catalogued) but its package never loaded — a
      // credential-less tool must not be rehydrated dead.
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          { factoryId: "@workbench/tools-a/a", toolName: GRANTED },
          {
            factoryId: "@workbench/tools-b/b",
            toolName: UNGRANTED,
            throwCredential: true,
          },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [GRANTED, UNGRANTED],
        warmKeep: true,
        storeDir,
      });
      const dynamic = built.agentEnv[DYNAMIC_TOOLS_ENV_KEY] as {
        exposure: { exposed: Set<string> };
      };
      expect(dynamic.exposure.exposed).toEqual(new Set([GRANTED]));
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("degrades a corrupt exposure file to an empty set without failing the build", async () => {
    const storeDir = await makeStoreDir();
    try {
      await fs.promises.writeFile(
        path.join(storeDir, "tool-exposure.json"),
        "not json{{",
      );
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          { factoryId: "@workbench/tools-a/a", toolName: GRANTED },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [GRANTED],
        warmKeep: true,
        storeDir,
      });
      const dynamic = built.agentEnv[DYNAMIC_TOOLS_ENV_KEY] as {
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
      loadToolPackagesMock.mockImplementation(async () =>
        fakePackages([
          { factoryId: "@workbench/tools-a/a", toolName: GRANTED },
        ]),
      );
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [GRANTED],
        warmKeep: true,
        storeDir,
      });
      const result = await built.tools.run(
        { id: "c1", name: LOAD_TOOLS_NAME, arguments: { names: [GRANTED] } },
        new AbortController().signal,
      );
      expect(result.isError).not.toBe(true);
      let persisted: string[] = [];
      for (let i = 0; i < 50; i += 1) {
        persisted = (await readPersistedExposure(storeDir)).exposed;
        if (persisted.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(persisted).toEqual([GRANTED]);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });
});

describe("warm single-step agent: no auto-injected local tools", () => {
  it("advertises zero POSIX tool names on the warm Myra path", async () => {
    // Product contract: warm single-step (Myra) must not auto-inject POSIX.
    const storeDir = await makeStoreDir();
    try {
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
      });
      const names = built.tools.definitions.map((d) => d.name);
      for (const posixName of POSIX_TOOL_NAMES) {
        expect(names).not.toContain(posixName);
      }
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });

  it("does not advertise mail_* tools on the warm path even when transport is present", async () => {
    // Mail is a det-step construct; warm must not advertise mail tools even
    // when the substrate places a transport on the step env.
    const storeDir = await makeStoreDir();
    try {
      const built = await buildWarmAgent({
        systemPrompt: MYRA_PROMPT,
        grantedLlmNames: [],
        warmKeep: true,
        storeDir,
        // Minimal stub: createMailTools only holds the handle for definitions.
        transport: {},
      });
      const names = built.tools.definitions.map((d) => d.name);
      const mailNames = names.filter((n) => n.startsWith("mail_"));
      expect(mailNames).toEqual([]);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });
});
