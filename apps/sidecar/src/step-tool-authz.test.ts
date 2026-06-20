// Step-agent tool authorization, exercised against the REAL `@intx/authz`
// `evaluateGrants` and the production `tool:<name>`/`invoke` grammar the
// step-agent reactor actually queries.
//
// This file deliberately does NOT stub `@intx/authz`. `mock.module` is
// process-global within a single `bun test` invocation, so co-locating a
// real-evaluator test with files that stub `@intx/authz`
// (`default-harness.test.ts`, `step-tool-harness.test.ts`) would let the stub
// leak in and mask a broken wiring. Run it isolated via the package's
// `test:authz` script (`bun test src/step-tool-authz.test.ts`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { evaluateGrants } from "@intx/authz";

// `default-harness.test.ts` installs a process-global `mock.module` stub for
// `@intx/authz` that leaks into this file under a shared `bun test` run. The
// real evaluator returns a populated `resolvedBy` on an allow match; the stub
// always returns `resolvedBy: null`. Detect the stub and skip — the real
// assertions run via the package's `test:authz` script, which runs this file
// in isolation where the stub is absent.
async function realAuthzActive(): Promise<boolean> {
  const probe = await evaluateGrants(
    [
      {
        id: "probe",
        resource: "tool:probe",
        action: "invoke",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: null,
      },
    ],
    "tool:probe",
    "invoke",
  );
  // The leaked stub returns `undefined`; the real evaluator returns a
  // populated AuthzResult with a non-null `resolvedBy` on an allow match.
  return probe?.effect === "allow" && probe.resolvedBy !== null;
}
import type { Agent, AgentDefinition, AuthorizeFn, BaseEnv } from "@intx/agent";

import {
  createStepAgentFactory,
  STEP_TOOL_CONTEXT_KEY,
  type StepToolContext,
} from "./step-tool-harness";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Empty manifest + credentials so the loader materializes zero tarballs; the
// test targets the grants-backed `authorize` the factory installs.
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

// The exact grammar the hub writes to `state/grants.json` and the reactor
// evaluates: `tool:<name>` / `invoke` / allow.
const GRANOLA_INVOKE_GRANT: StepToolContext["grants"][number] = {
  id: "grt_test_granola",
  resource: "tool:granola_get_meeting",
  action: "invoke",
  effect: "allow",
  origin: "system",
  conditions: null,
  expiresAt: null,
  roleId: null,
  principalId: null,
};

function makeStoreDir(): string {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-tool-authz-"));
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
  return {
    sources: [],
    defaultSource: "src",
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

const def = {
  id: "ins_dep-1-analyze",
  systemPrompt: "analyze",
  toolFactories: [],
  capabilities: [],
  inference: { sources: [] },
} as unknown as AgentDefinition;

const REAL_AUTHZ = await realAuthzActive();

describe.skipIf(!REAL_AUTHZ)(
  "createStepAgentFactory authorize (real @intx/authz)",
  () => {
    runRealAuthzTests();
  },
);

function runRealAuthzTests(): void {
  test("real evaluateGrants allows a granted tool's invoke", async () => {
    stubHubFetch();
    const { factory, captured } = makeCapturingAgentFactory();
    const stepFactory = createStepAgentFactory({ agentFactory: factory });
    const storeDir = makeStoreDir();

    await stepFactory(
      def,
      makeStepEnv(makeCtx([GRANOLA_INVOKE_GRANT], storeDir), storeDir),
    );

    expect(captured.authorize).not.toBeNull();
    const result = await captured.authorize!(
      "tool:granola_get_meeting",
      "invoke",
      {},
    );
    expect(result.effect).toBe("allow");
  });

  test("real evaluateGrants denies an ungranted tool's invoke", async () => {
    stubHubFetch();
    const { factory, captured } = makeCapturingAgentFactory();
    const stepFactory = createStepAgentFactory({ agentFactory: factory });
    const storeDir = makeStoreDir();

    await stepFactory(
      def,
      makeStepEnv(makeCtx([GRANOLA_INVOKE_GRANT], storeDir), storeDir),
    );

    expect(captured.authorize).not.toBeNull();
    const result = await captured.authorize!(
      "tool:gamma_generate",
      "invoke",
      {},
    );
    expect(result.effect).not.toBe("allow");
  });

  test("real evaluateGrants denies every tool when the step has no grants", async () => {
    stubHubFetch();
    const { factory, captured } = makeCapturingAgentFactory();
    const stepFactory = createStepAgentFactory({ agentFactory: factory });
    const storeDir = makeStoreDir();

    await stepFactory(def, makeStepEnv(makeCtx([], storeDir), storeDir));

    const result = await captured.authorize!(
      "tool:granola_get_meeting",
      "invoke",
      {},
    );
    expect(result.effect).not.toBe("allow");
  });
}
