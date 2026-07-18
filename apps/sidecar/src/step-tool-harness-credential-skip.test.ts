// A tenant that hasn't configured an optional tool provider (e.g. notion)
// should not WARN on every step launch — that's expected, not a fault.
// getToolCredential throws ToolCredentialMissingError when the env key is
// entirely absent; the harness must detect it via `err.name` (tool packages
// load from published tarballs, so `instanceof` can miss across bundle
// copies of the class) and log at info, not warn. A malformed credential
// (present but invalid) is still a wiring fault and must still warn.
//
// mock.module is process-global; this file mocks @intx/log and must run
// under `bun test --isolate`. The mock is registered before the harness is
// imported.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createIsogitStore } from "@workbench/storage-isogit";
import { ToolCredentialMissingError } from "@workbench/tool-credentials";

interface LoggedCall {
  message: string;
  fields: Record<string, unknown> | undefined;
}
const warnCalls: LoggedCall[] = [];
const infoCalls: LoggedCall[] = [];
const spyLogger = {
  error: () => {},
  warn: (message: string, fields?: Record<string, unknown>) => {
    warnCalls.push({ message, fields });
  },
  info: (message: string, fields?: Record<string, unknown>) => {
    infoCalls.push({ message, fields });
  },
  debug: () => {},
  trace: () => {},
  fatal: () => {},
};
mock.module("@intx/log", () => ({
  getLogger: () => spyLogger,
}));

type LoadedPackage = { factories: { id: string; requires: string[] }[] };
const loadToolPackagesMock = mock(async (): Promise<LoadedPackage[]> => []);

mock.module("./agent-tools", () => ({
  loadToolPackages: loadToolPackagesMock,
  fetchToolCredentials: mock(async () => ({})),
  mergeToolRunners: (_runners: unknown[]) => ({
    definitions: [],
    run: async () => ({ callId: "x", content: "" }),
  }),
  // step-tool-harness now statically imports filterToolRunner (warm single-step
  // path); the mock must export it or the module fails to link under the mock.
  filterToolRunner: (runner: unknown) => runner,
}));

const { createStepAgentFactory, STEP_TOOL_CONTEXT_KEY } = await import(
  "./step-tool-harness"
);

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];

beforeEach(() => {
  warnCalls.length = 0;
  infoCalls.length = 0;
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
    if (url.includes("/api/internal/tools/manifest")) {
      return new Response(
        JSON.stringify({
          manifest: { schemaVersion: "1", topLevel: [], entries: [] },
          tarballs: [],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

async function buildStepEnv(): Promise<Record<string, unknown>> {
  const storeDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "step-tool-cred-skip-"),
  );
  tmpDirs.push(storeDir);
  const workdir = path.join(storeDir, "workspace");
  await fs.promises.mkdir(workdir, { recursive: true });
  const storage = await createIsogitStore(storeDir, async (p: string) => p);
  return {
    sources: [],
    defaultSource: "",
    storage,
    workdir,
    audit: storage,
    directors: {},
    [STEP_TOOL_CONTEXT_KEY]: {
      hubHttpUrl: "http://hub.invalid",
      sidecarToken: "tok",
      tenantId: "ten_1",
      stepAgentId: "ins_dep-render",
      stepAddress: "ins_dep-render",
      principalId: "ins_dep-render",
      grants: [],
      // loadToolPackages is module-mocked here; the on-disk read just needs a
      // valid dir (no deploy/ → undefined manifest, ignored by the mock).
      deployTreeDir: storeDir,
      cacheRoot: path.join(storeDir, "cache"),
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
    },
  };
}

const fakeAgent = {
  send: async () => ({}),
  close: async () => {},
};

describe("step tool harness: missing-credential skip is quiet", () => {
  test("a factory throwing ToolCredentialMissingError is skipped at info level, not warn", async () => {
    stubHubFetch();
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          Object.assign(
            () => {
              throw new ToolCredentialMissingError("notion");
            },
            { id: "@workbench/tools-notion/notion", requires: [] },
          ),
        ],
      },
    ]);

    const env = await buildStepEnv();
    const factory = createStepAgentFactory({
      agentFactory: async () => fakeAgent as never,
    });
    await factory({ id: "step-def" } as never, env as never);

    expect(
      warnCalls.some((c) => c.message.includes("failed to construct")),
    ).toBe(false);
    const skipLog = infoCalls.find((c) =>
      c.message.includes("no credential configured"),
    );
    expect(skipLog).toBeTruthy();
    expect(skipLog?.fields?.providerName).toBe("notion");
  });

  test("a factory throwing a generic Error still warns", async () => {
    stubHubFetch();
    loadToolPackagesMock.mockImplementationOnce(async () => [
      {
        factories: [
          Object.assign(
            () => {
              throw new Error("Notion credential malformed");
            },
            { id: "@workbench/tools-notion/notion", requires: [] },
          ),
        ],
      },
    ]);

    const env = await buildStepEnv();
    const factory = createStepAgentFactory({
      agentFactory: async () => fakeAgent as never,
    });
    await factory({ id: "step-def" } as never, env as never);

    expect(
      warnCalls.some((c) => c.message.includes("failed to construct")),
    ).toBe(true);
    expect(
      infoCalls.some((c) => c.message.includes("no credential configured")),
    ).toBe(false);
  });
});
