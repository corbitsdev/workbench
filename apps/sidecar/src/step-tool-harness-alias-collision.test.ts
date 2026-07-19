// CL-3929 round 2 (non-blocking cleanup): two canonical package-tool names
// that happen to reduce to the same `toLlmToolName` alias (same package
// short-name segment + same tool name, from two distinct factory ids) must
// not silently shadow one another via last-write-wins `Map.set` in the warm
// agent's alias projection — log it loudly so a real collision is a visible
// operational signal.
//
// mock.module is process-global; this file mocks @intx/log and must run
// under `bun test --isolate`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createIsogitStore } from "@workbench/storage-isogit";

interface LoggedCall {
  message: string;
  fields: Record<string, unknown> | undefined;
}
const errorCalls: LoggedCall[] = [];
const spyLogger = {
  error: (message: string, fields?: Record<string, unknown>) => {
    errorCalls.push({ message, fields });
  },
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
};
mock.module("@intx/log", () => ({
  getLogger: () => spyLogger,
}));

type LoadedPackage = {
  factories: { id: string; requires: string[] }[];
};
const loadToolPackagesMock = mock(async (): Promise<LoadedPackage[]> => []);

mock.module("./agent-tools", () => ({
  loadToolPackages: loadToolPackagesMock,
  fetchToolCredentials: mock(async () => ({})),
  mergeToolRunners: (
    runners: { definitions: { name: string }[]; run: unknown }[],
  ) => {
    const allDefinitions = runners.flatMap((r) => r.definitions);
    const toolToRunner = new Map<string, (typeof runners)[number]>();
    for (const runner of runners) {
      for (const def of runner.definitions) toolToRunner.set(def.name, runner);
    }
    return {
      definitions: allDefinitions,
      async run(
        call: { id: string; name: string },
        signal: AbortSignal,
      ) {
        const runner = toolToRunner.get(call.name);
        if (!runner) {
          return {
            callId: call.id,
            content: { error: `Tool "${call.name}" is not available` },
          };
        }
        return (
          runner.run as (
            call: unknown,
            signal: AbortSignal,
          ) => Promise<{ callId: string; content: unknown }>
        )(call, signal);
      },
    };
  },
  filterToolRunner: (
    runner: { definitions: { name: string }[]; run: unknown },
    allowedNames: Set<string>,
  ) => ({
    definitions: runner.definitions.filter((d) => allowedNames.has(d.name)),
    async run(call: { id: string; name: string }, signal: AbortSignal) {
      if (!allowedNames.has(call.name)) {
        return {
          callId: call.id,
          content: { error: `Tool "${call.name}" is not enabled` },
        };
      }
      return (
        runner.run as (
          call: unknown,
          signal: AbortSignal,
        ) => Promise<{ callId: string; content: unknown }>
      )(call, signal);
    },
  }),
}));

const { createStepAgentFactory, STEP_TOOL_CONTEXT_KEY } = await import(
  "./step-tool-harness"
);

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];
beforeEach(() => {
  errorCalls.length = 0;
  loadToolPackagesMock.mockClear();
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(
    tmpDirs.map((d) => fs.promises.rm(d, { recursive: true, force: true })),
  );
  tmpDirs.length = 0;
});

function stubHubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

// Two distinct canonical names that share a package short-name segment
// ("shared") and tool name ("bar"), so `toLlmToolName` maps both to
// "shared__bar" — a genuine, if contrived, alias collision.
const CANONICAL_A = "@workbench/tools-foo/shared:bar";
const CANONICAL_B = "@workbench/other-tools/shared:bar";

describe("warm single-step agent: LLM-safe alias collision is logged, not silent (CL-3929)", () => {
  test("a same-alias collision between two canonical package tool names logs an error", async () => {
    stubHubFetch();
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          Object.assign(
            () => ({
              definitions: [{ name: CANONICAL_A }],
              run: async (call: { id: string }) => ({
                callId: call.id,
                content: { ok: "a" },
              }),
            }),
            { id: "@workbench/tools-foo/shared", requires: [] as string[] },
          ),
          Object.assign(
            () => ({
              definitions: [{ name: CANONICAL_B }],
              run: async (call: { id: string }) => ({
                callId: call.id,
                content: { ok: "b" },
              }),
            }),
            { id: "@workbench/other-tools/shared", requires: [] as string[] },
          ),
        ],
      },
    ]);

    const storeDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "wb-step-alias-collision-"),
    );
    tmpDirs.push(storeDir);
    const workdir = path.join(storeDir, "workspace");
    await fs.promises.mkdir(workdir, { recursive: true });
    const storage = await createIsogitStore(storeDir, async (p: string) => p);

    let capturedDef:
      | { toolFactories: readonly ((env: unknown) => {
          definitions: { name: string }[];
        })[] }
      | undefined;
    const factory = createStepAgentFactory({
      warmKeep: true,
      agentFactory: (async (def: unknown) => {
        capturedDef = def as never;
        return { send: async () => {}, close: async () => {} };
      }) as never,
    });

    const env = {
      sources: [],
      defaultSource: "",
      storage,
      workdir,
      audit: storage,
      directors: {},
      authorize: async () => ({
        effect: null,
        matchingGrants: [],
        resolvedBy: null,
      }),
      [STEP_TOOL_CONTEXT_KEY]: {
        hubHttpUrl: "http://hub.invalid",
        sidecarToken: "tok",
        tenantId: "ten_1",
        stepAgentId: "agt_myra",
        stepAddress: "myra@tenant.localhost",
        principalId: "prn_member_1",
        grants: [],
        deployTreeDir: storeDir,
        cacheRoot: path.join(storeDir, "cache"),
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
      },
    };
    const def = {
      id: "myra-def",
      // A plain (non-catalog) prompt still routes through the warm-agent
      // alias projection — `applyLlmSafeAliases` runs before the
      // dynamic-tool-config branch.
      systemPrompt: "You are a helpful assistant.",
      toolFactories: [],
      capabilities: [],
      inference: { sources: [] },
    };

    await factory(def as never, env as never);
    if (capturedDef === undefined) {
      throw new Error("agentFactory was not invoked");
    }
    const toolFactory = capturedDef.toolFactories[0];
    if (toolFactory === undefined) {
      throw new Error("step def has no tool factory");
    }
    const tools = toolFactory({});

    // Both canonical definitions alias to the same name — the collision, not
    // a crash, is the expected shape; the point of this test is that it is
    // logged loudly rather than silently absorbed by last-write-wins.
    expect(
      tools.definitions.filter((d) => d.name === "shared__bar"),
    ).toHaveLength(2);

    const collisionLog = errorCalls.find((c) =>
      c.message.includes("collision"),
    );
    expect(collisionLog).toBeTruthy();
    expect(collisionLog?.fields?.a).toBe(CANONICAL_A);
    expect(collisionLog?.fields?.b).toBe(CANONICAL_B);
    expect(collisionLog?.fields?.safe).toBe("shared__bar");
  });
});
