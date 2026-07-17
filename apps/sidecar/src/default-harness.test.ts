import { describe, it, expect, mock } from "bun:test";

// Mock heavy dependencies before importing the module under test.
// build() touches isogit and posix tools — all real filesystem/process
// operations. We mock at the module boundary to keep the tests fast and hermetic.

const createIsogitStoreMock = mock(async (..._args: unknown[]) => ({
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

const createMailAuditStoreMock = mock(async () => ({
  type: "mail-audit",
}));

mock.module("@workbench/storage-isogit", () => ({
  createIsogitStore: createIsogitStoreMock,
  createMailAuditStore: createMailAuditStoreMock,
}));

// The new runtime exposes events only through `harness.stream()`. The
// builder subscribes to it and forwards events, so the mocked harness
// must return an async-iterable stream that closes immediately.
const createHarnessMock = mock(async () => ({
  type: "harness",

  async *stream() {
    // Empty stream: closes immediately so the builder's forwarding
    // drain settles without emitting any event.
  },
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
    definitions: [{ name: "read_file" }, { name: "write_file" }],
    dispose: mock(async () => {}),
    run: mock(async () => ({ callId: "x", content: "" })),
  })),
}));

mock.module("@intx/authz", () => ({
  evaluateGrants: mock(async () => ({
    effect: null,
    matchingGrants: [],
    resolvedBy: null,
  })),
}));

mock.module("@intx/types/runtime", () => ({
  createBlobReader: mock(() => ({})),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  combineRunners,
  createDefaultHarnessBuilder,
  resolveMailOutboundLimit,
  wsUrlToHttp,
} from "./default-harness";
import { buildPersonalAgentSystemPrompt } from "@workbench/myra";
import { buildTimeZoneMarker, formatDateInTimeZone } from "@workbench/prompts";
import { createBuiltinRegistry } from "@intx/inference/providers";
import type {
  InferenceSource,
  ToolDefinition,
  ToolRunner,
} from "@intx/types/runtime";
const TEST_TENANT_ID = "tenant-1";

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

describe("wsUrlToHttp", () => {
  it("returns origin only, stripping the websocket path", () => {
    expect(
      wsUrlToHttp("ws://staging-hub.railway.internal:8080/api/sidecars/ws"),
    ).toBe("http://staging-hub.railway.internal:8080");
  });

  it("converts wss to https and strips the path", () => {
    expect(wsUrlToHttp("wss://hub.example.com/api/sidecars/ws")).toBe(
      "https://hub.example.com",
    );
  });

  it("handles a url with no path", () => {
    expect(wsUrlToHttp("ws://localhost:4000")).toBe("http://localhost:4000");
  });
});

describe("resolveMailOutboundLimit", () => {
  it("allows a higher per-turn outbound mail cap for Myra", () => {
    const prompt = buildPersonalAgentSystemPrompt("Myra", { xml: true });

    expect(resolveMailOutboundLimit(prompt)).toBe(100);
  });

  it("keeps the default cap for non-Myra agents", () => {
    expect(resolveMailOutboundLimit("You are a specialist agent.")).toBe(8);
  });
});

describe("createDefaultHarnessBuilder", () => {
  describe("canBuildSource", () => {
    it("does not throw for a registered provider", () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: "http://localhost:4000",
        sidecarToken: "test-token",
        cacheRoot: "/tmp/wb-test-tool-cache",
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
        adapters: createBuiltinRegistry(),
        gcPolicy: TEST_GC_POLICY,
      });
      expect(() => builder.canBuildSource(validSource)).not.toThrow();
    });

    it("throws for an unknown provider", () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: "http://localhost:4000",
        sidecarToken: "test-token",
        cacheRoot: "/tmp/wb-test-tool-cache",
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
        adapters: createBuiltinRegistry(),
        gcPolicy: TEST_GC_POLICY,
      });
      const unknownSource: InferenceSource = {
        ...validSource,
        provider: "unknown-provider-xyz",
      };
      expect(() => builder.canBuildSource(unknownSource)).toThrow(
        'Source provider "unknown-provider-xyz" is not registered',
      );
    });
  });

  describe("build()", () => {
    it("returns a bundle with harness, mailStore, and disposers", async () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: "http://localhost:4000",
        sidecarToken: "test-token",
        cacheRoot: "/tmp/wb-test-tool-cache",
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
        adapters: createBuiltinRegistry(),
        gcPolicy: TEST_GC_POLICY,
      });

      const bundle = await builder.build({
        agentAddress: "agent@tenant.localhost",
        agentConfig: {
          agentAddress: "agent@tenant.localhost",
          agentId: "agent-1",
          sessionId: "session-1",
          sources: [validSource],
          defaultSource: "src-1",
          grants: [],
          tools: [],
          principalId: "user-1",
          tenantId: "tenant-1",
          systemPrompt: "You are a helpful assistant.",
        },
        sources: [validSource],
        defaultSource: validSource.id,
        storeDir: "/tmp/test-store",
        agentTransport: {} as any,
        crypto: {
          signSSH: mock(() => "sig"),
        } as any,
        onEvent: mock(() => {}),
        onConnectorStateChanged: mock(() => {}),
      });

      expect(bundle.harness).toBeDefined();
      expect(bundle.mailStore).toBeDefined();
      expect(Array.isArray(bundle.disposers)).toBe(true);
      expect(bundle.disposers.length).toBeGreaterThan(0);

      // The boot-edge GC policy must reach the per-agent context store --
      // without it the reactor's write path never reclaims the repo.
      const lastCall =
        createIsogitStoreMock.mock.calls[
          createIsogitStoreMock.mock.calls.length - 1
        ];
      expect(lastCall?.[2]).toEqual(TEST_GC_POLICY);
    });

    it("runs storage/heal, mail-audit-store, and deploy-tree provisioning concurrently (CL-3799)", async () => {
      createIsogitStoreMock.mockClear();
      createMailAuditStoreMock.mockClear();
      readDeployTreeMock.mockClear();

      const DELAY_MS = 60;
      const delay = () =>
        new Promise((resolve) => setTimeout(resolve, DELAY_MS));

      createIsogitStoreMock.mockImplementationOnce(async () => {
        await delay();
        return {
          type: "isogit",
          load: mock(async () => ({
            turns: [],
            pendingOperations: [],
            tokenUsage: {},
            connectorState: null,
          })),
          writeTurns: mock(async () => {}),
          commit: mock(async () => ({})),
        };
      });
      createMailAuditStoreMock.mockImplementationOnce(async () => {
        await delay();
        return { type: "mail-audit" };
      });
      readDeployTreeMock.mockImplementationOnce(async () => {
        await delay();
        return { systemPrompt: undefined };
      });

      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: "http://localhost:4000",
        sidecarToken: "test-token",
        cacheRoot: "/tmp/wb-test-tool-cache",
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
        adapters: createBuiltinRegistry(),
        gcPolicy: TEST_GC_POLICY,
      });

      const start = performance.now();
      await builder.build({
        agentAddress: "agent@tenant.localhost",
        agentConfig: {
          agentAddress: "agent@tenant.localhost",
          agentId: "agent-1",
          sessionId: "session-1",
          sources: [validSource],
          defaultSource: "src-1",
          grants: [],
          tools: [],
          principalId: "user-1",
          tenantId: "tenant-1",
          systemPrompt: "You are a helpful assistant.",
        },
        sources: [validSource],
        defaultSource: validSource.id,
        storeDir: "/tmp/test-store",
        agentTransport: {} as any,
        crypto: { signSSH: mock(() => "sig") } as any,
        onEvent: mock(() => {}),
        onConnectorStateChanged: mock(() => {}),
      });
      const elapsed = performance.now() - start;

      // Three independent 60ms provisioning steps run serially would take
      // ~180ms; run concurrently they take ~60ms (plus the heal step, which
      // is chained after storage since it depends on it). A generous
      // threshold below the serial sum proves they overlap rather than queue.
      expect(elapsed).toBeLessThan(DELAY_MS * 2.5);
    });

    it("passes the source apiKey through to createHarness unchanged (plaintext)", async () => {
      createHarnessMock.mockClear();

      const plaintextSource: InferenceSource = {
        ...validSource,
        apiKey: "sk-plaintext-key",
      };

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
        agentAddress: "agent@tenant.localhost",
        agentConfig: {
          agentAddress: "agent@tenant.localhost",
          agentId: "agent-1",
          sessionId: "session-1",
          sources: [plaintextSource],
          defaultSource: "src-1",
          grants: [],
          tools: [],
          principalId: "user-1",
          tenantId: TEST_TENANT_ID,
          systemPrompt: "You are a helpful assistant.",
        },
        sources: [plaintextSource],
        defaultSource: plaintextSource.id,
        storeDir: "/tmp/test-store",
        agentTransport: {} as any,
        crypto: { signSSH: mock(() => "sig") } as any,
        onEvent: mock(() => {}),
        onConnectorStateChanged: mock(() => {}),
      });

      expect(createHarnessMock).toHaveBeenCalledTimes(1);
      // createHarness(def, env) — the source lives on the env (second argument),
      // not the definition. Secrets are plaintext at the app layer now.
      const callArgs = createHarnessMock.mock.calls[0] as unknown as [
        unknown,
        { sources: InferenceSource[]; defaultSource: string },
      ];
      expect(callArgs[1].sources[0]?.apiKey).toBe("sk-plaintext-key");
    });

    it("builds Myra's markerless prompt with no marker leak and seeds no files (CL-2413)", async () => {
      createHarnessMock.mockClear();
      const deployPrompt = buildPersonalAgentSystemPrompt("Myra", {
        xml: true,
      });
      readDeployTreeMock.mockImplementationOnce(async () => ({
        systemPrompt: deployPrompt,
      }));

      const storeDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "harness-seed-"),
      );
      try {
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
            tools: [],
            principalId: "user-1",
            tenantId: TEST_TENANT_ID,
            systemPrompt: "unused fallback",
          },
          sources: [validSource],
          defaultSource: validSource.id,
          storeDir,
          agentTransport: {} as any,
          crypto: { signSSH: mock(() => "sig") } as any,
          onEvent: mock(() => {}),
          onConnectorStateChanged: mock(() => {}),
        });

        const callArgs = createHarnessMock.mock.calls[0] as unknown as [
          { systemPrompt: string },
        ];
        const modelPrompt = callArgs[0].systemPrompt;
        // The model never sees its own control-plane marker.
        expect(modelPrompt).not.toContain("workbench:memory-seed");
        expect(modelPrompt).not.toContain("<!--");
        // But the substantive prompt body survives.
        expect(modelPrompt).toContain("You are Myra, Chief of Staff");

        // CL-2413: Myra seeds no workspace files — memory moved to the tools.
        const seeded = await fs.promises.readdir(
          path.join(storeDir, "workspace"),
        );
        expect(seeded).toEqual([]);
      } finally {
        await fs.promises.rm(storeDir, { recursive: true, force: true });
      }
    });

    it("does not abort the harness build when an OLD persisted prompt names a since-retired seed file (CL-2364)", async () => {
      createHarnessMock.mockClear();
      // Simulate an old persisted prompt whose marker lists a folded-away file.
      const stalePrompt = `${buildPersonalAgentSystemPrompt("Myra", {
        xml: true,
      })}\n\n<!-- workbench:memory-seed=MEMORY.md,CONTACTS.md,GONE.md -->`;
      readDeployTreeMock.mockImplementationOnce(async () => ({
        systemPrompt: stalePrompt,
      }));

      const storeDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "harness-seed-stale-"),
      );
      try {
        const builder = createDefaultHarnessBuilder({
          hubHttpUrl: "http://localhost:4000",
          sidecarToken: "test-token",
          cacheRoot: "/tmp/wb-test-tool-cache",
          cacheMaxBytes: 1024 * 1024,
          registryMaxTarballBytes: 1024 * 1024,
          adapters: createBuiltinRegistry(),
          gcPolicy: TEST_GC_POLICY,
        });

        const build = builder.build({
          agentAddress: "myra@tenant.localhost",
          agentConfig: {
            agentAddress: "myra@tenant.localhost",
            agentId: "agent-1",
            sessionId: "session-1",
            sources: [validSource],
            defaultSource: "src-1",
            grants: [],
            tools: [],
            principalId: "user-1",
            tenantId: TEST_TENANT_ID,
            systemPrompt: "unused fallback",
          },
          sources: [validSource],
          defaultSource: validSource.id,
          storeDir,
          agentTransport: {} as any,
          crypto: { signSSH: mock(() => "sig") } as any,
          onEvent: mock(() => {}),
          onConnectorStateChanged: mock(() => {}),
        });

        // The whole harness (inference + tools) must come up despite the stale
        // marker — MEMORY.md is classified retired (silent, CL-2413) and the
        // others skipped, none thrown.
        await expect(build).resolves.toBeDefined();

        const seeded = await fs.promises.readdir(
          path.join(storeDir, "workspace"),
        );
        expect(seeded).toEqual([]);
      } finally {
        await fs.promises.rm(storeDir, { recursive: true, force: true });
      }
    });

    it("forwards reactor events to onEvent, skipping message.received", async () => {
      // Without this forwarding the hub never sees inference/turn events, so
      // committed turns and streaming text only render after a manual reload.
      // message.received is reactor-internal and not an InferenceEvent.
      createHarnessMock.mockImplementationOnce((async () => ({
        type: "harness",

        async *stream() {
          yield { type: "inference.start", seq: 0, data: { model: "gpt-4o" } };
          yield { type: "message.received", seq: 1, data: { message: {} } };
          yield { type: "connector.reply", seq: 2, data: {} };
        },
        async close() {},
      })) as any);

      const onEvent = mock((_event: unknown) => {});
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: "http://localhost:4000",
        sidecarToken: "test-token",
        cacheRoot: "/tmp/wb-test-tool-cache",
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
        adapters: createBuiltinRegistry(),
        gcPolicy: TEST_GC_POLICY,
      });

      const bundle = await builder.build({
        agentAddress: "agent@tenant.localhost",
        agentConfig: {
          agentAddress: "agent@tenant.localhost",
          agentId: "agent-1",
          sessionId: "session-1",
          sources: [validSource],
          defaultSource: "src-1",
          grants: [],
          tools: [],
          principalId: "user-1",
          tenantId: TEST_TENANT_ID,
          systemPrompt: "You are a helpful assistant.",
        },
        sources: [validSource],
        defaultSource: validSource.id,
        storeDir: "/tmp/test-store",
        agentTransport: {} as any,
        crypto: { signSSH: mock(() => "sig") } as any,
        onEvent,
        onConnectorStateChanged: mock(() => {}),
      });

      // The forwarding drain runs detached; it settles when the (finite) stream
      // closes. The final disposer is the drain promise, so awaiting it
      // guarantees every event has been processed before asserting.
      await bundle.disposers[bundle.disposers.length - 1]?.();

      const forwarded = onEvent.mock.calls.map(
        (c) => (c[0] as { type: string }).type,
      );
      expect(forwarded).toEqual(["inference.start", "connector.reply"]);
    });
  });

  describe("combineRunners", () => {
    const makeRunner = (
      names: string[],
    ): ToolRunner & { definitions: ToolDefinition[] } => ({
      definitions: names.map((name) => ({ name }) as unknown as ToolDefinition),
      async run(call) {
        return { callId: call.id, content: `ran:${call.name}` };
      },
    });

    it("merges definitions from every runner", () => {
      const merged = combineRunners([
        makeRunner(["read_file"]),
        makeRunner(["artifact_link"]),
      ]);
      const names = merged.definitions.map((d) => d.name);
      expect(names).toContain("read_file");
      expect(names).toContain("artifact_link");
    });

    it("dispatches a call to the runner that owns the named tool", async () => {
      const merged = combineRunners([makeRunner(["a"]), makeRunner(["b"])]);
      const result = await merged.run(
        { id: "c1", name: "b", arguments: {} } as any,
        new AbortController().signal,
      );
      expect(result.content).toBe("ran:b");
    });

    it("returns an error result for an unregistered tool name", async () => {
      const merged = combineRunners([makeRunner(["a"])]);
      const result = await merged.run(
        { id: "c1", name: "missing", arguments: {} } as any,
        new AbortController().signal,
      );
      expect(result.isError).toBe(true);
    });
  });

  describe("hub tool runner composition", () => {
    it("excludes POSIX tools from the hub tool runner", async () => {
      const builder = createDefaultHarnessBuilder({
        hubHttpUrl: "http://localhost:4000",
        sidecarToken: "test-token",
        cacheRoot: "/tmp/wb-test-tool-cache",
        cacheMaxBytes: 1024 * 1024,
        registryMaxTarballBytes: 1024 * 1024,
        adapters: createBuiltinRegistry(),
        gcPolicy: TEST_GC_POLICY,
      });

      const bundle = await builder.build({
        agentAddress: "agent@tenant.localhost",
        agentConfig: {
          agentAddress: "agent@tenant.localhost",
          agentId: "agent-1",
          sessionId: "session-1",
          sources: [validSource],
          defaultSource: "src-1",
          grants: [],
          tools: [
            { name: "read_file" },
            { name: "write_file" },
            { name: "artifact_link_file" },
          ] as any,
          principalId: "user-1",
          tenantId: "tenant-1",
          systemPrompt: "You are a helpful assistant.",
        },
        sources: [validSource],
        defaultSource: validSource.id,
        storeDir: "/tmp/test-store",
        agentTransport: {} as any,
        crypto: {
          signSSH: mock(() => "sig"),
        } as any,
        onEvent: mock(() => {}),
        onConnectorStateChanged: mock(() => {}),
      });

      // The build succeeds: posix names (read_file/write_file) are not
      // re-sent to the hub tool runner, so no duplicate-name collision is
      // raised when the runners are combined.
      expect(bundle.harness).toBeDefined();
    });
  });
});

describe("active-context timezone (member timezone marker)", () => {
  function makeBuilder() {
    return createDefaultHarnessBuilder({
      hubHttpUrl: "http://localhost:4000",
      sidecarToken: "test-token",
      cacheRoot: "/tmp/wb-test-tool-cache",
      cacheMaxBytes: 1024 * 1024,
      registryMaxTarballBytes: 1024 * 1024,
      adapters: createBuiltinRegistry(),
      gcPolicy: TEST_GC_POLICY,
    });
  }

  async function buildAndCapturePrompt(deployPrompt: string): Promise<string> {
    createHarnessMock.mockClear();
    readDeployTreeMock.mockImplementationOnce(async () => ({
      systemPrompt: deployPrompt,
    }));
    await makeBuilder().build({
      agentAddress: "agent@tenant.localhost",
      agentConfig: {
        agentAddress: "agent@tenant.localhost",
        agentId: "agent-1",
        sessionId: "session-1",
        sources: [validSource],
        defaultSource: "src-1",
        grants: [],
        tools: [],
        principalId: "user-1",
        tenantId: TEST_TENANT_ID,
        systemPrompt: "unused fallback",
      },
      sources: [validSource],
      defaultSource: validSource.id,
      storeDir: "/tmp/test-store",
      agentTransport: {} as any,
      crypto: { signSSH: mock(() => "sig") } as any,
      onEvent: mock(() => {}),
      onConnectorStateChanged: mock(() => {}),
    });
    const callArgs = createHarnessMock.mock.calls[0] as unknown as [
      { systemPrompt: string },
    ];
    return callArgs[0].systemPrompt;
  }

  it("renders the active-context date in the marker's zone and strips the marker", async () => {
    const before = formatDateInTimeZone(new Date(), "America/Los_Angeles");
    const prompt = await buildAndCapturePrompt(
      `You are an agent.\n\n${buildTimeZoneMarker("America/Los_Angeles")}`,
    );
    const after = formatDateInTimeZone(new Date(), "America/Los_Angeles");
    expect(prompt).not.toContain("workbench:timezone");
    expect(
      prompt.includes(`Current date: ${before}`) ||
        prompt.includes(`Current date: ${after}`),
    ).toBe(true);
  });

  it("labels the date UTC when no marker is present — never silent server-local", async () => {
    const before = formatDateInTimeZone(new Date(), "UTC");
    const prompt = await buildAndCapturePrompt("You are an agent.");
    const after = formatDateInTimeZone(new Date(), "UTC");
    expect(
      prompt.includes(`Current date: ${before}`) ||
        prompt.includes(`Current date: ${after}`),
    ).toBe(true);
  });
});
