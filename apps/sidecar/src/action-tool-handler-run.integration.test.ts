// Proves the native `action` migration contract end to end: a native `action` step's
// `input` selector output flows through `@intx/workflow`'s REAL `runLocal` +
// action primitive, into the production `createActionToolHandlerRegistry`
// (`action-tool-handler.ts`), through `runDeterministicToolStep`
// (`step-tool-harness.ts`), and into a REAL tool loaded off a real on-disk
// deploy tree via `@intx/tool-packaging` — the exact chain the deployed
// sidecar drives. Only the hub HTTP boundary (`/api/internal/tools/credentials`)
// is stubbed; nothing under `@intx/*` or the harness itself is mocked.
//
// Three behaviors this test proves (the ones a mocked-boundary test cannot):
//
// 1. The action step's evaluated `input` selector is passed VERBATIM as the
//    tool's arguments — no argMap reshape, no wrapping, no dropped/renamed
//    keys. This is the entire contract that replaced `workbench.argMap`.
// 2. A "tolerant wrapper" tool result — outer `ToolResult.isError: false`,
//    with the tool's own soft failure encoded inside `content` as
//    `{ isError: true, error }` — completes the run. `runDeterministicToolStep`
//    only inspects the OUTER envelope
//    (`toolResultErrorMessage`/`step-tool-harness.ts`), so a tool that
//    encodes its own degraded result inside `content` must not fail the step.
// 3. A genuinely fatal tool result — outer `ToolResult.isError: true` — DOES
//    fail the step, and therefore the run. This is the other half of #2: a
//    test that only covered the tolerant case would not catch a wrapper that
//    accidentally swallows a real failure.
//
// Seams crossed FOR REAL: `@intx/workflow` (`defineWorkflow`, `action`,
// `runLocal`, the action primitive's runtime + `EffectContext`),
// `createActionToolHandlerRegistry` (production sidecar code, unmodified),
// `runDeterministicToolStep`/`buildStepTools` (production sidecar code),
// `@intx/tool-packaging`'s real loader against a real on-disk deploy tree,
// and a real (test-fixture) `@intx/agent` `defineTool` factory bundled with
// `Bun.build` and packed into a real tarball — not a mocked runner.
//
// Seams still mocked/unproven here: the hub HTTP boundary itself
// (`/api/internal/tools/credentials`, stubbed via `globalThis.fetch`); the
// real credential-fetch and hub-tools/run wiring a hub-backed tool package
// would exercise (covered instead by the existing
// `action-tool-handler.test.ts` gamma-templates positive-path test); the
// real sidecar process boundary (IPC, workflow-child spawn, supervisor) —
// this test calls the registry/handler in-process, the same way
// `action-tool-handler.test.ts` does. None of that is provable outside a
// deployed sidecar; this test's claim is bounded to the handler-resolution +
// tool-dispatch seam described above.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineWorkflow, action, runLocal } from "@intx/workflow";
import type { RepoId, RepoStore } from "@workbench/hub-sessions/substrate";
import type { StepInvokeRequest } from "@intx/workflow";
import { createActionToolHandlerRegistry } from "./action-tool-handler";

const FIXTURE_TOOL_NAME = "fixture_action_tool";
const CANONICAL_HANDLER = `@fixture/tools-fixture/fixture:${FIXTURE_TOOL_NAME}`;
const PACKAGE_NAME = "@fixture/tools-fixture";
const PACKAGE_VERSION = "0.1.0";
const ASSET_ID = "ast_fixture";
const MOUNT = "package-registries/workspace-builtins/";
const TARBALL_REL = "tarballs/fixture-tools-0.1.0.tgz";

const realFetch = globalThis.fetch;

/**
 * A minimal real `@intx/agent` `defineTool` factory, authored to a scratch
 * source file and compiled/packed exactly the way a production tool package
 * reaches the sidecar (a tarball referenced from `tool-packages-manifest.json`).
 * Its `run` behavior is driven entirely by `arguments.mode`, so the three
 * outer-envelope shapes under test (verbatim echo, tolerant soft-fail,
 * genuinely fatal) are all exercised through the REAL tool-packaging loader
 * and REAL `runner.run` dispatch, not a hand-rolled runner.
 */
const FIXTURE_TOOL_SOURCE = `
import { defineTool } from "@intx/agent";

export const fixture = defineTool({
  id: "${PACKAGE_NAME}/fixture",
  factory: () => ({
    definitions: [
      {
        name: "${FIXTURE_TOOL_NAME}",
        description: "Integration-test fixture tool",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
      },
    ],
    async run(call) {
      const args = call.arguments ?? {};
      if (args.mode === "verbatim") {
        return {
          callId: call.id,
          content: JSON.stringify({ receivedArgs: args }),
          isError: false,
        };
      }
      if (args.mode === "soft") {
        return {
          callId: call.id,
          content: JSON.stringify({ isError: true, error: "soft failure" }),
          isError: false,
        };
      }
      if (args.mode === "hard") {
        return {
          callId: call.id,
          content: "boom: fatal tool failure",
          isError: true,
        };
      }
      throw new Error(\`fixture tool: unknown mode "\${String(args.mode)}"\`);
    },
  }),
});
`;

let scratch: string;
let repoLocalTmpRoot: string;
let tarballBase64: string;
let tarballIntegrity: string;

async function packFixtureToolPackage(): Promise<void> {
  const staging = path.join(scratch, "staging", "package");
  await fs.promises.mkdir(path.join(staging, "src"), { recursive: true });
  await fs.promises.writeFile(
    path.join(staging, "src", "interchange-tools.ts"),
    FIXTURE_TOOL_SOURCE,
    "utf8",
  );

  const built = await Bun.build({
    entrypoints: [path.join(staging, "src", "interchange-tools.ts")],
    outdir: path.join(staging, "dist"),
    naming: "interchange-tools.js",
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
    conditions: ["intx-src"],
  });
  if (!built.success) {
    throw new Error(
      `Bun.build failed for fixture tool package:\n${built.logs.map(String).join("\n")}`,
    );
  }

  await fs.promises.writeFile(
    path.join(staging, "package.json"),
    JSON.stringify({
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      type: "module",
      interchange: { tools: "./dist/interchange-tools.js" },
    }),
  );

  const tarballPath = path.join(scratch, "fixture.tgz");
  const proc = Bun.spawn(
    [
      "tar",
      "-czf",
      tarballPath,
      "-C",
      path.join(scratch, "staging"),
      "package",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`tar failed: ${await new Response(proc.stderr).text()}`);
  }

  const bytes = await fs.promises.readFile(tarballPath);
  tarballBase64 = bytes.toString("base64");
  tarballIntegrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

async function stageDeployTree(deployTreeDir: string): Promise<void> {
  const deployDir = path.join(deployTreeDir, "deploy");
  await fs.promises.mkdir(deployDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(deployDir, "tool-packages-manifest.json"),
    JSON.stringify({
      schemaVersion: "1",
      topLevel: [{ name: PACKAGE_NAME, version: PACKAGE_VERSION }],
      entries: [
        {
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          integrity: tarballIntegrity,
          source: { kind: "asset", assetId: ASSET_ID, path: TARBALL_REL },
        },
      ],
    }),
  );
  await fs.promises.writeFile(
    path.join(deployDir, "asset-mounts.json"),
    JSON.stringify({ assetMounts: { [ASSET_ID]: MOUNT } }),
  );
  const tarballDest = path.join(deployTreeDir, "workspace", MOUNT, TARBALL_REL);
  await fs.promises.mkdir(path.dirname(tarballDest), { recursive: true });
  await fs.promises.writeFile(
    tarballDest,
    Buffer.from(tarballBase64, "base64"),
  );
}

function stubHubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/internal/tools/credentials")) {
      return Response.json({ credentials: {} });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

/**
 * Build the real production registry: a real on-disk workflow-definition
 * repo (one action step declaring `CANONICAL_HANDLER`) and a real staged
 * deploy tree carrying the fixture tarball. `createActionToolHandlerRegistry`
 * is called completely unmodified.
 */
async function buildRegistry(): Promise<
  (ref: string) => import("@intx/workflow").ActionHandler
> {
  const wfDir = await fs.promises.mkdtemp(path.join(scratch, "wf-def-"));
  await fs.promises.writeFile(
    path.join(wfDir, "workflow.json"),
    JSON.stringify({
      steps: { act: { kind: "action", handler: CANONICAL_HANDLER } },
    }),
    "utf8",
  );
  const deployTreeDir = await fs.promises.mkdtemp(
    path.join(scratch, "deploy-tree-"),
  );
  await stageDeployTree(deployTreeDir);
  const dataDir = await fs.promises.mkdtemp(path.join(scratch, "data-dir-"));
  const substrate: RepoStore = {
    getRepoDir: (_repoId: RepoId) => wfDir,
  } as unknown as RepoStore;

  return createActionToolHandlerRegistry({
    dataDir,
    substrate,
    workflowDefinitionRepoId: { kind: "workflow", id: "wf_fixture" },
    resolveStepToolContext: async (req: StepInvokeRequest) => ({
      hubHttpUrl: "https://hub.test",
      sidecarToken: "tok",
      tenantId: "ten_1",
      stepAgentId: req.authzContext.stepId ?? "act",
      stepAddress: req.authzContext.stepId ?? "act",
      principalId: req.authzContext.stepId ?? "act",
      grants: [],
      deployTreeDir,
      cacheRoot: path.join(deployTreeDir, "cache"),
      cacheMaxBytes: 64 * 1024 * 1024,
      registryMaxTarballBytes: 64 * 1024 * 1024,
    }),
  });
}

describe("action -> real tool dispatch, end to end (native action migration contract)", () => {
  beforeAll(async () => {
    // Bun.build resolves `@intx/agent` by walking UP from the entrypoint
    // looking for node_modules, so the fixture source must live somewhere
    // under the repo tree (not a bare os.tmpdir(), which has no node_modules
    // ancestor) — mirrors how action-tool-handler.test.ts builds the real
    // gamma package from its actual in-repo path.
    repoLocalTmpRoot = path.join(
      import.meta.dir,
      "..",
      ".action-run-integration-tmp",
    );
    await fs.promises.mkdir(repoLocalTmpRoot, { recursive: true });
    scratch = await fs.promises.mkdtemp(
      path.join(repoLocalTmpRoot, "scratch-"),
    );
    stubHubFetch();
    await packFixtureToolPackage();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await fs.promises.rm(repoLocalTmpRoot, { recursive: true, force: true });
  });

  test("1. the action step's evaluated input selector is passed VERBATIM as the tool's arguments", async () => {
    const actionResolver = await buildRegistry();
    const triggerPayload = {
      mode: "verbatim",
      customKey: "should-pass-through-untouched",
      nested: { a: 1, b: [1, 2, 3] },
    };
    const def = defineWorkflow({
      id: "act-verbatim",
      trigger: { type: "manual" },
      steps: {
        act: action({
          handler: CANONICAL_HANDLER,
          input: { from: "trigger.payload" },
          effect: { requires: [CANONICAL_HANDLER] },
        }),
      },
    });

    const result = await runLocal(def, {
      triggerPayload,
      actionResolver,
    }).complete;

    expect(result.terminalStatus).toBe("completed");
    const output = result.outputs.act as Record<string, unknown>;
    expect(output.isError).not.toBe(true);
    const parsed = JSON.parse(String(output.content)) as {
      receivedArgs: unknown;
    };
    // Exact equality: no key dropped, renamed, or wrapped — the entire
    // contract argMap used to own.
    expect(parsed.receivedArgs).toEqual(triggerPayload);
  });

  test("2. a tolerant wrapper's degraded result (outer isError: false, soft failure encoded in content) completes the run", async () => {
    const actionResolver = await buildRegistry();
    const def = defineWorkflow({
      id: "act-soft-fail",
      trigger: { type: "manual" },
      steps: {
        act: action({
          handler: CANONICAL_HANDLER,
          input: { literal: { mode: "soft" } },
          effect: { requires: [CANONICAL_HANDLER] },
        }),
      },
    });

    const result = await runLocal(def, { actionResolver }).complete;

    expect(result.terminalStatus).toBe("completed");
    const output = result.outputs.act as Record<string, unknown>;
    // Outer envelope reports success ...
    expect(output.isError).not.toBe(true);
    // ... even though the tool's own content encodes a soft failure.
    const parsed = JSON.parse(String(output.content)) as {
      isError: boolean;
      error: string;
    };
    expect(parsed.isError).toBe(true);
    expect(parsed.error).toBe("soft failure");
  });

  test("3. a genuinely fatal tool result (outer isError: true) DOES fail the step and the run", async () => {
    const actionResolver = await buildRegistry();
    const def = defineWorkflow({
      id: "act-hard-fail",
      trigger: { type: "manual" },
      steps: {
        act: action({
          handler: CANONICAL_HANDLER,
          input: { literal: { mode: "hard" } },
          effect: { requires: [CANONICAL_HANDLER] },
        }),
      },
    });

    const result = await runLocal(def, { actionResolver }).complete;

    expect(result.terminalStatus).toBe("failed");
  });
});
