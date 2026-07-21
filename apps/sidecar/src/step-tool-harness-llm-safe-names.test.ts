import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition, ToolRunner } from "@intx/types/runtime";

// CL-3929: the sidecar's step tool harness build a warm single-step agent's
// (Myra/Oat) tool runner from the on-disk deploy tree via
// `@intx/tool-packaging`'s `loadManifest`, which unconditionally prefixes
// every tool-package definition with `<factoryId>:<name>` (e.g.
// `@workbench/tools-exa/exa:exa_search`, see
// `interchange/packages/tool-packaging/src/loader.ts`'s `applyNamespacePrefix`).
// That canonical name is illegal on the LLM wire and does not round-trip
// (kimi truncates at the `:`), so CL-2306 introduced `toLlmToolName` (e.g.
// `exa__search`) as the alias the model and the dynamic tool catalog
// (`packages/agent-core/src/dynamic-tools-catalog.ts`) both use.
//
// The retired in-process `default-harness.ts` applied this alias mapping
// before handing definitions to the model; when Myra/Oat were re-homed onto
// this step-tool-harness as a warm single-step workflow deployment (the
// interchange runtime-retirement pin bump), that mapping was never
// re-applied here. `buildStepTools` populated `packageToolNames` straight
// from the loader's raw canonical (colon-form) names, so
// `createCatalogTools`'s `isAvailable` (comparing the catalog's LLM-safe
// name against `packageToolNames`) never finds a match for ANY successfully
// loaded, credentialed, granted package tool — `load_tools` reports it as
// needing a credential that was never actually missing.
//
// This test drives the REAL `createStepAgentFactory` with a fake
// `loadToolPackages` result shaped exactly like the real loader's output
// (canonical colon-prefixed names) for the real `exa` pin Myra's catalog
// advertises, with the hub credential rail stubbed to succeed. It must NOT
// report the tool as needing a credential.

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
const fetchToolCredentialsMock = mock(
  async (): Promise<Record<string, { apiKey: string; baseURL: string }>> => ({
    "workbench.cred.exa": { apiKey: "k", baseURL: "https://exa.invalid" },
  }),
);

mock.module("./agent-tools", () => ({
  loadToolPackages: loadToolPackagesMock,
  fetchToolCredentials: fetchToolCredentialsMock,
  mergeToolRunners,
  filterToolRunner,
  wsUrlToHttp: (u: string) => u,
}));

import {
  createStepAgentFactory,
  runDeterministicToolStep,
  STEP_TOOL_CONTEXT_KEY,
} from "./step-tool-harness";
import { buildPersonalAgentSystemPrompt } from "@workbench/myra";

const MYRA_PROMPT = buildPersonalAgentSystemPrompt("Myra", { xml: true });

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mock(async () => ({
    ok: false,
    status: 500,
  })) as unknown as typeof fetch;
  loadToolPackagesMock.mockReset();
  loadToolPackagesMock.mockImplementation(async () => []);
  fetchToolCredentialsMock.mockClear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function toolGrants(llmNames: string[]): unknown[] {
  return llmNames.map((name) => ({
    id: `grant-${name}`,
    resource: `tool:${name}`,
    action: "invoke",
    effect: "allow",
    conditions: null,
  }));
}

// Shaped exactly like `@intx/tool-packaging`'s `applyNamespacePrefix` output:
// the factory's bundle definitions carry the canonical `<factoryId>:<name>`
// form, never the LLM-safe alias.
const EXA_FACTORY_ID = "@workbench/tools-exa/exa";
const EXA_CANONICAL_NAME = `${EXA_FACTORY_ID}:exa_search`;
const EXA_LLM_NAME = "exa__search";

function fakeExaPackage(run: (call: { id: string }) => Promise<{
  callId: string;
  content: unknown;
}>): unknown[] {
  return [
    {
      factories: [
        Object.assign(
          () => ({
            definitions: [{ name: EXA_CANONICAL_NAME }],
            run,
          }),
          { id: EXA_FACTORY_ID, requires: ["workbench.cred.exa"] },
        ),
      ],
    },
  ];
}

async function buildWarmAgent(storeDir: string): Promise<DefinedRunner> {
  let capturedDef:
    | { toolFactories: readonly ((env: unknown) => DefinedRunner)[] }
    | undefined;
  const factory = createStepAgentFactory({
    warmKeep: true,
    agentFactory: (async (def: unknown) => {
      capturedDef = def as {
        toolFactories: readonly ((env: unknown) => DefinedRunner)[];
      };
      return { send: async () => {}, close: async () => {} };
    }) as never,
  });

  const workdir = path.join(storeDir, "workspace");
  await fs.promises.mkdir(workdir, { recursive: true });

  const ctx = {
    hubHttpUrl: "http://localhost:4000",
    sidecarToken: "test-token",
    tenantId: "tenant-1",
    stepAgentId: "agt_myra_kimi",
    stepAddress: "myra@tenant.localhost",
    principalId: "prn_member_1",
    grants: toolGrants([EXA_LLM_NAME]) as never,
    deployTreeDir: storeDir,
    cacheRoot: path.join(storeDir, "cache"),
    cacheMaxBytes: 1024 * 1024,
    registryMaxTarballBytes: 1024 * 1024,
  };

  const env = {
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

  const def = {
    id: "myra-def",
    systemPrompt: MYRA_PROMPT,
    toolFactories: [],
    capabilities: [],
    inference: { sources: [] },
  };

  await factory(def as never, env as never);
  if (capturedDef === undefined) throw new Error("agentFactory was not invoked");
  const toolFactory = capturedDef.toolFactories[0];
  if (toolFactory === undefined) throw new Error("step def has no tool factory");
  return toolFactory({});
}

describe("step tool harness: LLM-safe package tool names (CL-3929)", () => {
  it("does not report a successfully-loaded, credentialed, granted package tool as needing a credential", async () => {
    const storeDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "wb-step-llm-safe-"),
    );
    try {
      const packageRun = mock(async (call: { id: string }) => ({
        callId: call.id,
        content: { results: [] },
      }));
      loadToolPackagesMock.mockImplementation(async () =>
        fakeExaPackage(packageRun),
      );

      const tools = await buildWarmAgent(storeDir);

      const searchResult = await tools.run(
        {
          id: "call-search",
          name: "search_tools",
          arguments: { query: "web search" },
        },
        new AbortController().signal,
      );
      const content = searchResult.content as {
        hint?: string;
        needsCredential?: string[];
        packages?: { tools: { name: string }[] }[];
      };
      expect(content.hint ?? "").not.toContain("needs a credential");
      expect(content.needsCredential ?? []).not.toContain(EXA_LLM_NAME);

      const loadResult = await tools.run(
        {
          id: "call-load",
          name: "load_tools",
          arguments: { names: [EXA_LLM_NAME] },
        },
        new AbortController().signal,
      );
      const loadContent = loadResult.content as {
        loaded: string[];
        needsCredential?: string[];
        note: string;
      };
      expect(loadContent.needsCredential ?? []).not.toContain(EXA_LLM_NAME);
      expect(loadContent.loaded).toContain(EXA_LLM_NAME);
      expect(loadContent.note).not.toContain("needs a credential");

      const callResult = await tools.run(
        { id: "call-1", name: EXA_LLM_NAME, arguments: { query: "x" } },
        new AbortController().signal,
      );
      expect(callResult.isError).not.toBe(true);
      expect(packageRun).toHaveBeenCalledTimes(1);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });
});

// CL-3929 round 2: `buildStepTools` is shared with `runDeterministicToolStep`,
// which dispatches by the CANONICAL colon-form name a deterministic workflow
// step declares (`deterministicToolStep`'s `STEP_TOOL_TAG`, threaded through
// `workflow-substrate-factory.ts`). The LLM-safe alias projection above must
// be scoped to the warm-agent path only — this pins that `buildStepTools`
// itself still exposes and dispatches the CANONICAL name, so a deterministic
// step referencing a real package tool (e.g. reddit-opportunity-scanner's
// `reddit_subreddit_search`, sumble-account-intel, attio-task-agent) keeps
// working. This would have failed against the round-1 fix, which renamed
// `buildStepTools`'s definitions unconditionally and threw
// `StepToolNotRegisteredError` for a canonical-name lookup.
describe("runDeterministicToolStep: canonical (non-aliased) dispatch (CL-3929 round 2)", () => {
  it("dispatches a package tool by its canonical colon-form name, not the LLM-safe alias", async () => {
    const storeDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "wb-step-det-canonical-"),
    );
    try {
      const packageRun = mock(async (call: { id: string }) => ({
        callId: call.id,
        content: { results: ["ok"] },
      }));
      loadToolPackagesMock.mockImplementation(async () =>
        fakeExaPackage(packageRun),
      );

      const workdir = path.join(storeDir, "workspace");
      await fs.promises.mkdir(workdir, { recursive: true });
      const ctx = {
        hubHttpUrl: "http://localhost:4000",
        sidecarToken: "test-token",
        tenantId: "tenant-1",
        stepAgentId: "ins_dep-search",
        stepAddress: "ins_dep-search",
        principalId: "ins_dep-search",
        grants: [],
        deployTreeDir: storeDir,
        cacheRoot: path.join(storeDir, "cache"),
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
      };
      const env: Record<string, unknown> = {
        sources: [],
        defaultSource: "",
        workdir,
        directors: {},
        [STEP_TOOL_CONTEXT_KEY]: ctx,
      };

      const result = await runDeterministicToolStep({
        env: env as never,
        toolName: EXA_CANONICAL_NAME,
        input: { query: "gtm workbench" },
        signal: new AbortController().signal,
      });

      expect(result.output).toMatchObject({
        content: { results: ["ok"] },
      });
      expect(packageRun).toHaveBeenCalledTimes(1);
      const dispatchedCall = packageRun.mock.calls[0]?.[0] as
        | { name: string }
        | undefined;
      expect(dispatchedCall?.name).toBe(EXA_CANONICAL_NAME);
    } finally {
      await fs.promises.rm(storeDir, { recursive: true, force: true });
    }
  });
});
