// Proves the host-side action-handler seam this issue ships: a plain,
// flat `handler` ref (the tool's canonical name, nothing more — no
// Workbench prefix, no embedded step identity) resolves to a PURE
// `ActionHandler` — `(input, ctx, signal) => output`, no `ctx.authzContext`
// read anywhere — that runs the tool through the SAME real
// `buildStepTools`/credential/infra-fault-classification path
// `runDeterministicToolStep` gives deterministic workflow steps, not a mock
// of it. Every action step's tool closure is resolved EAGERLY at registry
// construction, straight off the real on-disk workflow-definition repo —
// not at first invocation. Only the hub HTTP boundary is stubbed
// (`globalThis.fetch`), mirroring `step-tool-deterministic.test.ts`; every
// other component (the real `@intx/workflow` `ActionHandler` contract, the
// real repo store, the real tool-loading path) is real.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { EffectContext, StepInvokeRequest } from "@intx/workflow";
import type { RepoId, RepoStore } from "@workbench/hub-sessions/substrate";
import {
  createChildOutboundMailBridge,
  type ChildOutboundMailBridge,
} from "@workbench/workflow-host";
import type {
  ControlPayload,
  ControlChannelSender,
} from "@workbench/workflow-host";
import type { StepToolContext } from "./step-tool-harness";
import { isStepToolInfrastructureFault } from "./step-tool-harness";
import { createActionToolHandlerRegistry } from "./action-tool-handler";

const realFetch = globalThis.fetch;
const tmpDirs: string[] = [];
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
    if (url.includes("/api/internal/tools/credentials")) {
      return new Response(JSON.stringify({ credentials: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

async function makeDataDir(): Promise<string> {
  const dataDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "action-tool-handler-"),
  );
  tmpDirs.push(dataDir);
  return dataDir;
}

/** Empty on-disk deploy tree: no `deploy/` subtree means no pinned tools. */
async function makeEmptyDeployTree(): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "action-deploy-tree-"),
  );
  tmpDirs.push(dir);
  return dir;
}

function stepToolContextFixture(deployTreeDir: string): StepToolContext {
  return {
    hubHttpUrl: "http://hub.invalid",
    sidecarToken: "tok",
    tenantId: "ten_1",
    stepAgentId: "ins_dep-step-1",
    stepAddress: "ins_dep-step-1",
    principalId: "ins_dep-step-1",
    grants: [],
    deployTreeDir,
    cacheRoot: path.join(deployTreeDir, "cache"),
    cacheMaxBytes: 1024 * 1024,
    registryMaxTarballBytes: 1024 * 1024,
  };
}

const WORKFLOW_DEFINITION_REPO_ID: RepoId = {
  kind: "workflow",
  id: "wf_test",
};

/**
 * Write a minimal real `workflow.json` onto a real on-disk directory and
 * back it with a `getRepoDir`-only `RepoStore` stub pointed at it — the
 * exact file `loadActionHandlerStepIds` reads and the exact file
 * `packages/workflow-host`'s `loadWorkflowDefinition` reads moments later
 * in production. Real `fs.readFile` against a real directory, not a mocked
 * reader; only the rest of `RepoStore`'s surface (never called by this
 * seam) is unimplemented.
 */
async function writeWorkflowDefinition(
  steps: Record<string, { kind: string; handler?: string }>,
): Promise<{ substrate: RepoStore }> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "action-workflow-def-"),
  );
  tmpDirs.push(dir);
  await fs.promises.writeFile(
    path.join(dir, "workflow.json"),
    JSON.stringify({ steps }),
    "utf8",
  );
  const substrate: RepoStore = {
    getRepoDir: (_repoId: RepoId) => dir,
  } as unknown as RepoStore;
  return { substrate };
}

describe("createActionToolHandlerRegistry", () => {
  test("eagerly resolves every action step's tool closure at construction — the step id came from the definition, not from any invocation", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const deployTreeDir = await makeEmptyDeployTree();
    const seenStepIds: string[] = [];
    const { substrate } = await writeWorkflowDefinition({
      "step-3": {
        kind: "action",
        handler: "@workbench/tools-gamma/gamma:create_deck",
      },
    });

    // Registry construction itself resolves the tool context — proven by
    // `seenStepIds` being populated (with the ref's OWN step id, "step-3",
    // read straight off the workflow definition) before any handler is
    // ever invoked. No `deploy/` subtree under `deployTreeDir` means the
    // tool was never pinned, so construction fails closed here — the
    // exact production incident this project ships to prevent surfaces at
    // establish, not at the action's first dispatch deep into a run.
    await expect(
      createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
        resolveStepToolContext: async (req: StepInvokeRequest) => {
          seenStepIds.push(req.authzContext.stepId ?? "");
          return stepToolContextFixture(deployTreeDir);
        },
      }),
    ).rejects.toThrow(/is not registered\/available for this deployment/);
    expect(seenStepIds).toEqual(["step-3"]);
  });

  test("a missing tool package fails at REGISTRY CONSTRUCTION (establish), not at first invocation", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const deployTreeDir = await makeEmptyDeployTree();
    const { substrate } = await writeWorkflowDefinition({
      "step-1": { kind: "action", handler: "some_unpinned_tool" },
    });

    // Never reaches handler invocation: construction itself rejects.
    await expect(
      createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
        resolveStepToolContext: async () =>
          stepToolContextFixture(deployTreeDir),
      }),
    ).rejects.toThrow(/is not registered\/available for this deployment/);
  });

  test("a not-pinned tool at construction is classified an infrastructure fault, not a data/execution fault", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const deployTreeDir = await makeEmptyDeployTree();
    const { substrate } = await writeWorkflowDefinition({
      "step-1": { kind: "action", handler: "some_tool" },
    });

    try {
      await createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
        resolveStepToolContext: async () =>
          stepToolContextFixture(deployTreeDir),
      });
      throw new Error("expected construction to throw for the unpinned tool");
    } catch (cause) {
      expect(isStepToolInfrastructureFault(cause)).toBe(true);
    }
  });

  test("an unknown ref throws — no action step in the definition declares it", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const { substrate } = await writeWorkflowDefinition({});

    const registry = await createActionToolHandlerRegistry({
      dataDir,
      substrate,
      workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
      resolveStepToolContext: async () => {
        throw new Error("must not be called: zero action steps declared");
      },
    });

    expect(() => registry("nonexistent_tool")).toThrow(
      /no action step in the workflow definition declares this handler ref/,
    );
  });

  test("reclaims the preflight scratch dir even when construction rejects", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const deployTreeDir = await makeEmptyDeployTree();
    const { substrate } = await writeWorkflowDefinition({
      "step-1": { kind: "action", handler: "some_tool" },
    });

    await expect(
      createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
        resolveStepToolContext: async () =>
          stepToolContextFixture(deployTreeDir),
      }),
    ).rejects.toThrow();

    const preflightRoot = path.join(
      dataDir,
      "workflow-action-scratch",
      "preflight",
      "some_tool",
    );
    const leftovers = await fs.promises
      .readdir(preflightRoot, { recursive: true })
      .catch(() => [] as string[]);
    expect(leftovers.length).toBe(0);
  });
});

// Positive-path coverage: the eagerly-bound `ActionHandler` closure itself
// (`bindActionHandler`'s returned function, the code every test above never
// reaches because it aborts at registry construction). Packs the real
// `@workbench/tools-gamma` interchange-tools entry into a tarball and stages
// it as a real on-disk deploy tree — the same real repo-store/fs/tool-loading
// path `step-tool-gamma-templates.integration.test.ts` drives — so the
// handler resolves and dispatches through the REAL `buildStepTools`/
// `runDeterministicToolStep` path, not a mocked runner. Only the hub HTTP
// boundary (`/api/internal/tools/credentials`, `/api/internal/hub-tools/run`)
// is stubbed.
describe("createActionToolHandlerRegistry — bound handler positive path", () => {
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

  /** Mirrors action-tool-handler.ts's own `sanitizeForPath`. */
  function sanitizeForPath(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]/g, "_");
  }

  /**
   * The per-call scratch dir (`<dataDir>/workflow-action-scratch/<tool>/<uuid>`)
   * is reclaimed via `rm(scratchDir, { recursive: true })`, which removes the
   * uuid-keyed leaf but leaves its empty `<tool>` parent behind (created by
   * the earlier `mkdir(workdir, { recursive: true })`) — an artifact of the
   * mkdir/rm pairing, not evidence of a leaked call. Reclamation is proven by
   * the tool-named directory itself being empty, not by the whole
   * `workflow-action-scratch` tree being gone.
   */
  async function toolScratchLeftovers(
    dataDir: string,
    toolName: string,
  ): Promise<string[]> {
    const toolDir = path.join(
      dataDir,
      "workflow-action-scratch",
      sanitizeForPath(toolName),
    );
    return fs.promises
      .readdir(toolDir, { recursive: true })
      .catch(() => [] as string[]);
  }

  let scratch: string;
  let tarballBase64: string;
  let tarballIntegrity: string;
  const realFetch2 = globalThis.fetch;

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
      conditions: ["intx-src"],
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
    const tarballDest = path.join(
      deployTreeDir,
      "workspace",
      MOUNT,
      TARBALL_REL,
    );
    await fs.promises.mkdir(path.dirname(tarballDest), { recursive: true });
    await fs.promises.writeFile(
      tarballDest,
      Buffer.from(tarballBase64, "base64"),
    );
  }

  function stubHubFetch(opts: {
    seenHubToolCalls: unknown[];
    onHubToolRun?: () => Promise<void> | void;
    hubToolRunThrows?: boolean;
  }): void {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/api/internal/tools/credentials")) {
        return Response.json({ credentials: {} });
      }
      if (url.includes("/api/internal/hub-tools/run")) {
        if (opts.onHubToolRun !== undefined) await opts.onHubToolRun();
        if (opts.hubToolRunThrows === true) {
          throw new Error("simulated hub-tools/run failure");
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        opts.seenHubToolCalls.push(body);
        return Response.json({
          result: JSON.stringify(TEMPLATES),
          isError: false,
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }) as unknown as typeof fetch;
  }

  async function writeActionWorkflowDefinition(): Promise<{
    substrate: RepoStore;
    deployTreeDir: string;
  }> {
    const wfDir = await fs.promises.mkdtemp(path.join(scratch, "wf-def-"));
    await fs.promises.writeFile(
      path.join(wfDir, "workflow.json"),
      JSON.stringify({
        steps: {
          "step-1": { kind: "action", handler: CANONICAL_TOOL },
        },
      }),
      "utf8",
    );
    const deployTreeDir = await fs.promises.mkdtemp(
      path.join(scratch, "deploy-tree-"),
    );
    await stageDeployTree(deployTreeDir);
    const substrate: RepoStore = {
      getRepoDir: (_repoId: RepoId) => wfDir,
    } as unknown as RepoStore;
    return { substrate, deployTreeDir };
  }

  /**
   * Minimal `EffectContext` carrying nothing but `perform` — no `stepId`, no
   * `runId`, no identity field of any kind. If the bound handler secretly
   * read `ctx.authzContext` (or any invocation-time identity) it would break
   * against this ctx, since there is nothing to read; a clean success proves
   * the handler is pure with respect to its `ctx` argument.
   */
  function bareEffectContext(requires: readonly string[]): EffectContext {
    const allowed = new Set(requires);
    return {
      async perform({ capability, run }) {
        if (!allowed.has(capability)) {
          throw new Error(`capability ${capability} not declared`);
        }
        return run();
      },
    };
  }

  beforeAll(async () => {
    scratch = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "action-handler-positive-"),
    );
    await packRealGammaToolPackage();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch2;
    await fs.promises.rm(scratch, { recursive: true, force: true });
  });

  test("returns the tool's real output, and the per-call scratch dir exists during the call and is gone after", async () => {
    const seenHubToolCalls: unknown[] = [];
    let scratchDuringCall: string[] = [];
    const dataDir = await fs.promises.mkdtemp(path.join(scratch, "data-dir-"));
    const scratchRoot = path.join(dataDir, "workflow-action-scratch");

    stubHubFetch({
      seenHubToolCalls,
      onHubToolRun: async () => {
        scratchDuringCall = await fs.promises
          .readdir(scratchRoot, { recursive: true })
          .catch(() => [] as string[]);
      },
    });
    try {
      const { substrate, deployTreeDir } =
        await writeActionWorkflowDefinition();

      const registry = await createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: { kind: "workflow", id: "wf_test" },
        resolveStepToolContext: async (req: StepInvokeRequest) => ({
          hubHttpUrl: "https://hub.test",
          sidecarToken: "tok",
          tenantId: "ten_1",
          stepAgentId: req.authzContext.stepId ?? "step-1",
          stepAddress: req.authzContext.stepId ?? "step-1",
          principalId: req.authzContext.stepId ?? "step-1",
          grants: [],
          deployTreeDir,
          cacheRoot: path.join(deployTreeDir, "cache"),
          cacheMaxBytes: 64 * 1024 * 1024,
          registryMaxTarballBytes: 64 * 1024 * 1024,
        }),
      });

      // The preflight-only scratch dir under `dataDir` was already reclaimed
      // by construction; nothing to see here yet.
      const handler = registry(CANONICAL_TOOL);
      const output = await handler(
        null,
        bareEffectContext([CANONICAL_TOOL]),
        new AbortController().signal,
      );

      const record = output as Record<string, unknown>;
      expect(record.isError).not.toBe(true);
      expect(JSON.parse(String(record.content))).toEqual(TEMPLATES);
      expect(seenHubToolCalls).toEqual([
        expect.objectContaining({ toolName: "gamma_list_templates" }),
      ]);

      // Proves the handler actually created a fresh per-call scratch dir
      // (not reusing the preflight one, not skipping it): something existed
      // under workflow-action-scratch while the tool call was in flight.
      expect(scratchDuringCall.length).toBeGreaterThan(0);

      // Proves the success-path `finally` reclaimed it: nothing survives the
      // call.
      const leftovers = await toolScratchLeftovers(dataDir, CANONICAL_TOOL);
      expect(leftovers.length).toBe(0);
    } finally {
      globalThis.fetch = realFetch2;
    }
  });

  test("a tool that throws still reclaims its per-call scratch dir", async () => {
    const seenHubToolCalls: unknown[] = [];
    const dataDir = await fs.promises.mkdtemp(
      path.join(scratch, "data-dir-fail-"),
    );

    stubHubFetch({ seenHubToolCalls, hubToolRunThrows: true });
    try {
      const { substrate, deployTreeDir } =
        await writeActionWorkflowDefinition();

      const registry = await createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: { kind: "workflow", id: "wf_test" },
        resolveStepToolContext: async () => ({
          hubHttpUrl: "https://hub.test",
          sidecarToken: "tok",
          tenantId: "ten_1",
          stepAgentId: "step-1",
          stepAddress: "step-1",
          principalId: "step-1",
          grants: [],
          deployTreeDir,
          cacheRoot: path.join(deployTreeDir, "cache"),
          cacheMaxBytes: 64 * 1024 * 1024,
          registryMaxTarballBytes: 64 * 1024 * 1024,
        }),
      });

      const handler = registry(CANONICAL_TOOL);
      await expect(
        handler(
          null,
          bareEffectContext([CANONICAL_TOOL]),
          new AbortController().signal,
        ),
      ).rejects.toThrow();

      const leftovers = await toolScratchLeftovers(dataDir, CANONICAL_TOOL);
      expect(leftovers.length).toBe(0);
    } finally {
      globalThis.fetch = realFetch2;
    }
  });
});

// Reproduces the live production incident: a native `action` step declaring
// a local-runner mail tool (`mail_send`) crashed `createActionToolHandlerRegistry`
// at construction — `assertStepToolResolvable`'s `available` set never
// contained a mail tool name because the action path's scratch env never
// wired a mail transport the way `createSidecarStepBuildEnv` wires one for a
// deterministic/inference step. Proves both directions: the fix resolves AND
// dispatches a mail action for real (through a real `ChildOutboundMailBridge`,
// not a mock of the mail tools), and a genuinely unknown tool name still
// fails the same way it always did — the check is not weakened into a
// blanket local-runner bypass.
describe("createActionToolHandlerRegistry — mail action steps (local-runner tools)", () => {
  /** Auto-resolves every `outbound.message` frame as a successful send, so
   * `bridge.submit` (and therefore the mail tool's `send` call) resolves
   * without a real supervisor process on the other end of the IPC. */
  function createAutoResolvingMailBridge(): {
    bridge: ChildOutboundMailBridge;
    sentMessages: Extract<
      ControlPayload,
      { type: "outbound.message" }
    >["data"][];
  } {
    const sentMessages: Extract<
      ControlPayload,
      { type: "outbound.message" }
    >["data"][] = [];
    let bridge: ChildOutboundMailBridge;
    const sender: ControlChannelSender = {
      get seq() {
        return sentMessages.length;
      },
      async send(payload: ControlPayload) {
        if (payload.type !== "outbound.message") return;
        sentMessages.push(payload.data);
        bridge.handleResult({
          requestId: payload.data.requestId,
          result: {
            ok: true,
            messageId: "<m-test@example.com>",
            status: "delivered",
          },
        });
      },
    };
    bridge = createChildOutboundMailBridge({ upstreamSender: sender });
    return { bridge, sentMessages };
  }

  test("a mail_send action step throws StepToolNotRegisteredError when no mail transport is wired (mailbox-less deployment)", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const deployTreeDir = await makeEmptyDeployTree();
    const { substrate } = await writeWorkflowDefinition({
      "heartbeat-notify": { kind: "action", handler: "mail_send" },
    });

    await expect(
      createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
        resolveStepToolContext: async () =>
          stepToolContextFixture(deployTreeDir),
        // No outboundMailBridge/mailboxAddress — mirrors the un-fixed
        // action path and a genuine mailbox-less deployment.
      }),
    ).rejects.toThrow(/is not registered\/available for this deployment/);
  });

  test("a mail_send action step resolves and dispatches through the real mail transport once the deployment's mail bridge + address are wired", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const deployTreeDir = await makeEmptyDeployTree();
    const { substrate } = await writeWorkflowDefinition({
      "heartbeat-notify": { kind: "action", handler: "mail_send" },
    });
    const { bridge, sentMessages } = createAutoResolvingMailBridge();

    const registry = await createActionToolHandlerRegistry({
      dataDir,
      substrate,
      workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
      resolveStepToolContext: async () => stepToolContextFixture(deployTreeDir),
      outboundMailBridge: bridge,
      mailboxAddress: "ins_dep-step-1@workbench.test",
    });

    const handler = registry("mail_send");
    const output = await handler(
      { to: "usr_recipient@workbench.test", subject: "hi", content: "body" },
      {
        async perform({ run }) {
          return run();
        },
      },
      new AbortController().signal,
    );

    // The handler actually reached the real bridge/transport, not a
    // dispatch-time no-op: the send frame carries the mailbox address as
    // sender and the declared recipient/content.
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.senderAddress).toBe(
      "ins_dep-step-1@workbench.test",
    );
    expect(sentMessages[0]?.message.to).toBe("usr_recipient@workbench.test");
    const record = output as Record<string, unknown>;
    expect(record.isError).not.toBe(true);
  });

  test("an unknown tool name still fails clearly even with a mail transport wired — the fix does not blanket-bypass the availability check", async () => {
    stubHubFetch();
    const dataDir = await makeDataDir();
    const deployTreeDir = await makeEmptyDeployTree();
    const { substrate } = await writeWorkflowDefinition({
      "step-1": { kind: "action", handler: "totally_unknown_tool" },
    });
    const { bridge } = createAutoResolvingMailBridge();

    await expect(
      createActionToolHandlerRegistry({
        dataDir,
        substrate,
        workflowDefinitionRepoId: WORKFLOW_DEFINITION_REPO_ID,
        resolveStepToolContext: async () =>
          stepToolContextFixture(deployTreeDir),
        outboundMailBridge: bridge,
        mailboxAddress: "ins_dep-step-1@workbench.test",
      }),
    ).rejects.toThrow(/is not registered\/available for this deployment/);
  });
});
