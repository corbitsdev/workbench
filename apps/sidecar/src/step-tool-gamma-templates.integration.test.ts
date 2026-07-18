// CL-2597 regression: gamma_list_templates was unreachable from workflow
// steps — it existed only as a hub ContextToolEntry, a rail the step-tool
// harness never consults, so a deterministicToolStep declaring it always
// failed with StepToolNotRegisteredError. This test drives the REAL step
// rail end to end: it packs the actual @workbench/tools-gamma
// `interchange.tools` entry into a tarball, serves it through a stubbed
// manifest endpoint, and asserts `runDeterministicToolStep` loads the
// hub-backed gamma-templates factory, resolves the canonical prefixed tool
// name, and forwards the call to the hub's `/api/internal/hub-tools/run`
// boundary (stubbed — the hub side is covered by the hub route tests).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createIsogitStore } from "@workbench/storage-isogit";

import {
  runDeterministicToolStep,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PACKAGE_NAME = "@workbench/tools-gamma";
const PACKAGE_VERSION = "0.1.0";
const ASSET_ID = "ast_builtin";
const MOUNT = "package-registries/workspace-builtins/";
const TARBALL_REL = "tarballs/workbench-tools-gamma-0.1.0.tgz";
const CANONICAL_TOOL =
  "@workbench/tools-gamma/gamma-templates:gamma_list_templates";

const TEMPLATES = [
  { gammaId: "g-1", name: "Sales Deck", description: "Quarterly sales deck" },
];

const realFetch = globalThis.fetch;
let scratch: string;
let tarballBase64: string;
let tarballIntegrity: string;

async function packRealGammaToolPackage(): Promise<void> {
  const staging = path.join(scratch, "staging", "package");
  await fs.promises.mkdir(path.join(staging, "dist"), { recursive: true });

  const built = await Bun.build({
    entrypoints: [
      path.join(
        REPO_ROOT,
        "packages",
        "tools-gamma",
        "src",
        "interchange-tools.ts",
      ),
    ],
    outdir: path.join(staging, "dist"),
    naming: "interchange-tools.js",
    target: "node",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!built.success) {
    throw new Error(
      `Bun.build failed for tools-gamma interchange entry:\n${built.logs.map(String).join("\n")}`,
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

  const tarballPath = path.join(scratch, "gamma.tgz");
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

// Stage the resolved tool-package manifest + the real tarball on disk exactly
// as the hub's deploy-time staging (`deployInstanceAtHead` / `stageWorkflowStep`)
// would: `deploy/tool-packages-manifest.json`, `deploy/asset-mounts.json`, and
// the tarball under `workspace/<mount>/<path>`. The sidecar then materializes
// the pinned closure straight off disk — the on-disk model.
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

function stubHubFetch(seenHubToolCalls: unknown[]): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (url.includes("/api/internal/tools/credentials")) {
      // No gamma credential: the credentialed gamma factory fails to
      // construct and is skipped, proving the hub-backed gamma-templates
      // factory loads independently of the Gamma API credential.
      return Response.json({ credentials: {} });
    }
    if (url.includes("/api/internal/hub-tools/run")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seenHubToolCalls.push(body);
      return Response.json({
        result: JSON.stringify(TEMPLATES),
        isError: false,
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

async function makeEnv(): Promise<Record<string, unknown>> {
  const storeDir = await fs.promises.mkdtemp(path.join(scratch, "step-store-"));
  const workdir = path.join(storeDir, "workspace");
  await fs.promises.mkdir(workdir, { recursive: true });
  const deployTreeDir = await fs.promises.mkdtemp(
    path.join(scratch, "deploy-tree-"),
  );
  await stageDeployTree(deployTreeDir);
  const storage = await createIsogitStore(storeDir, async (p: string) => p);
  const ctx: StepToolContext = {
    hubHttpUrl: "https://hub.test",
    sidecarToken: "tok",
    tenantId: "ten_1",
    stepAgentId: "ins_dep-list-templates",
    stepAddress: "ins_dep-list-templates",
    principalId: "ins_dep-list-templates",
    grants: [],
    deployTreeDir,
    cacheRoot: path.join(storeDir, "cache"),
    cacheMaxBytes: 64 * 1024 * 1024,
    registryMaxTarballBytes: 64 * 1024 * 1024,
  };
  return {
    sources: [],
    defaultSource: "",
    storage,
    workdir,
    audit: storage,
    directors: {},
    [STEP_TOOL_CONTEXT_KEY]: ctx,
  };
}

beforeAll(async () => {
  scratch = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "gamma-templates-step-"),
  );
  await packRealGammaToolPackage();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await fs.promises.rm(scratch, { recursive: true, force: true });
});

describe("gamma_list_templates over the workflow step-tool rail (CL-2597)", () => {
  test("a deterministic step resolves the canonical name and forwards to the hub-RPC boundary", async () => {
    const seenHubToolCalls: unknown[] = [];
    stubHubFetch(seenHubToolCalls);
    try {
      const env = await makeEnv();
      const result = await runDeterministicToolStep({
        env: env as never,
        toolName: CANONICAL_TOOL,
        input: null,
        signal: new AbortController().signal,
      });

      const output = result.output as Record<string, unknown>;
      expect(output.isError).not.toBe(true);
      expect(JSON.parse(String(output.content))).toEqual(TEMPLATES);
      // The hub receives the BARE tool name (the HUB_BACKED_TOOLS key), with
      // the step agent presented as its own principal.
      expect(seenHubToolCalls).toEqual([
        expect.objectContaining({
          toolName: "gamma_list_templates",
          tenantId: "ten_1",
          agentId: "ins_dep-list-templates",
          principalId: "ins_dep-list-templates",
        }),
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
