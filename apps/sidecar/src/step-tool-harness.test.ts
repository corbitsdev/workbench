import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Agent, AgentDefinition, AuthorizeFn, BaseEnv } from "@intx/agent";

// `mock.module` is process-global and leaks across files in this suite
// (default-harness.test.ts stubs `@intx/authz` to a no-op). Pin a faithful
// glob-matching evaluator here so the step factory's grants→authorize
// wiring is exercised deterministically regardless of file order: the
// evaluator implements the same allow/deny semantics `@intx/authz` does, so
// asserting allow-on-match / deny-on-miss tests the factory's wiring, not a
// canned mock return.
function matchPattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) return value.startsWith(pattern.slice(0, -1));
  return pattern === value;
}
mock.module("@intx/authz", () => ({
  evaluateGrants: async (
    grants: Array<{ resource: string; action: string; effect: string }>,
    resource: string,
    action: string,
  ) => {
    const match = grants.find(
      (g) =>
        matchPattern(g.resource, resource) && matchPattern(g.action, action),
    );
    return {
      effect: match ? match.effect : null,
      matchingGrants: [],
      resolvedBy: null,
    };
  },
}));

import {
  createStepAgentFactory,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The hub's manifest + credential endpoints. The manifest is empty (no
// pinned packages) so the loader materializes zero tarballs — the test
// targets the grants-backed `authorize` the step factory installs, which is
// what gates whether a step's tool calls are permitted.
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
    if (url.includes("/api/internal/tools/credentials")) {
      return new Response(JSON.stringify({ credentials: {} }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

// A grant allowing `read` on `granola:*`. The sidecar GrantRule grammar is
// the shape `@intx/authz`'s `evaluateGrants` consumes (singular
// resource/action patterns); this is the minimal allow rule for the
// resource/action under test.
const GRANOLA_READ_GRANT: StepToolContext["grants"][number] = {
  id: "grt_test_granola",
  resource: "granola:*",
  action: "read",
  effect: "allow",
  origin: "role",
  conditions: null,
  expiresAt: null,
  roleId: null,
  principalId: null,
};

function makeStoreDir(): string {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-tool-harness-"));
  fs.mkdirSync(path.join(storeDir, "workspace"), { recursive: true });
  return storeDir;
}

function makeCtx(
  grants: StepToolContext["grants"],
  storeDir: string,
): StepToolContext {
  return {
    hubHttpUrl: "https://hub.test",
    sidecarToken: "tok",
    tenantId: "t1",
    stepAgentId: "ins_dep-1-analyze",
    stepAddress: "ins_dep-1-analyze",
    principalId: "ins_dep-1-analyze",
    grants,
    cacheRoot: path.join(storeDir, "cache"),
    cacheMaxBytes: 1024 * 1024,
    registryMaxTarballBytes: 1024 * 1024,
  };
}

// Capture the env the factory hands to the underlying agent constructor so
// the test can drive the installed `authorize` directly.
function makeCapturingAgentFactory(): {
  factory: <E extends BaseEnv>(
    def: AgentDefinition<E>,
    env: E,
  ) => Promise<Agent>;
  captured: { authorize: AuthorizeFn | null };
} {
  const captured: { authorize: AuthorizeFn | null } = { authorize: null };
  const factory = (async <E extends BaseEnv>(
    _def: AgentDefinition<E>,
    env: E,
  ): Promise<Agent> => {
    captured.authorize = env.authorize;
    return {
      send: async () => ({ reply: "", turn: null }),
      stream: async function* () {},
      deliver: () => {},
      close: async () => {},
      setSource: () => {},
      setSources: () => {},
      history: async () => [],
      checkpoints: async () => [],
    } as unknown as Agent;
  }) as <E extends BaseEnv>(def: AgentDefinition<E>, env: E) => Promise<Agent>;
  return { factory, captured };
}

function makeStepEnv(
  ctx: StepToolContext,
  storeDir: string,
): BaseEnv & Record<string, unknown> {
  // The step env carries the StepToolContext stash plus the BaseEnv slots
  // the buildEnv path fills; the factory reads `storage`/`workdir` for the
  // local posix tools.
  return {
    sources: [],
    defaultSource: "src",
    // The factory only reads `storage` to build a blob reader for posix
    // tools; a minimal stub satisfies that read.
    storage: {
      load: async () => ({ turns: [] }),
    } as unknown as BaseEnv["storage"],
    workdir: path.join(storeDir, "workspace"),
    audit: {} as BaseEnv["audit"],
    authorize: (async () => ({ effect: "deny" })) as unknown as AuthorizeFn,
    directors: {} as BaseEnv["directors"],
    [STEP_TOOL_CONTEXT_KEY]: ctx,
  };
}

describe("createStepAgentFactory authorize", () => {
  const def = {
    id: "ins_dep-1-analyze",
    systemPrompt: "analyze",
    toolFactories: [],
    capabilities: [],
    inference: { sources: [] },
  } as unknown as AgentDefinition;

  test("permits a tool action the step was granted", async () => {
    stubHubFetch();
    const { factory, captured } = makeCapturingAgentFactory();
    const stepFactory = createStepAgentFactory({ agentFactory: factory });

    const storeDir = makeStoreDir();

    await stepFactory(
      def,
      makeStepEnv(makeCtx([GRANOLA_READ_GRANT], storeDir), storeDir),
    );

    expect(captured.authorize).not.toBeNull();
    const result = await captured.authorize!("granola:meeting-123", "read", {});
    expect(result.effect).toBe("allow");
  });

  test("denies a tool action the step was not granted", async () => {
    stubHubFetch();
    const { factory, captured } = makeCapturingAgentFactory();
    const stepFactory = createStepAgentFactory({ agentFactory: factory });

    const storeDir = makeStoreDir();

    // Granted granola:read only — a gamma generate action is ungranted.
    await stepFactory(
      def,
      makeStepEnv(makeCtx([GRANOLA_READ_GRANT], storeDir), storeDir),
    );

    expect(captured.authorize).not.toBeNull();
    // No grant matches gamma:generate, so the effect resolves to null
    // (no-match) — the reactor treats a non-allow effect as denied.
    const result = await captured.authorize!("gamma:deck-1", "generate", {});
    expect(result.effect).not.toBe("allow");
  });

  test("denies everything when the step has no grants (fail-closed)", async () => {
    stubHubFetch();
    const { factory, captured } = makeCapturingAgentFactory();
    const stepFactory = createStepAgentFactory({ agentFactory: factory });

    const storeDir = makeStoreDir();

    await stepFactory(def, makeStepEnv(makeCtx([], storeDir), storeDir));

    const result = await captured.authorize!("granola:meeting-123", "read", {});
    expect(result.effect).not.toBe("allow");
  });
});
